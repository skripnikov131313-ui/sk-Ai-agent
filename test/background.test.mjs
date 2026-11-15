import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, isAlive, readTasks, writeTasks } from '../src/store.mjs';
import { backgroundStatus, startBackground, stopBackground, recoverBackground } from '../src/background.mjs';
import { runProcess } from '../src/process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/work-codex.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('./fixtures/background-launch.mjs', import.meta.url));

async function setup(t, cases) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'background-')));
  const dataDir = path.join(root, '.skai-agent');
  t.after(async () => {
    const state = await backgroundStatus(dataDir);
    if (['running', 'starting'].includes(state?.status)) await stopBackground(dataDir);
    if (state && state.status !== 'unknown') await waitUntilStopped(dataDir);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'PLAN.md'), `# Plan\n\n${cases.map(item => `- [ ] CASE=${item}`).join('\n')}\n`);
  return { root, dataDir, dbFile: path.join(dataDir, 'tasks.json'), source: 'PLAN.md',
    command: process.execPath, prefixArgs: [fixture], taskTimeoutMs: 600_000, graceMs: 50 };
}

async function waitUntilStopped(dataDir) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await backgroundStatus(dataDir);
    if (!['running', 'starting'].includes(state?.status) &&
        (process.platform !== 'win32' || !state?.processAlive)) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('background worker did not stop before deadline');
}

test('background work survives the launcher exiting and stops its active native child cooperatively', async t => {
  const options = await setup(t, ['hold', 'next']);
  const optionsFile = path.join(options.root, 'options.json');
  await writeFile(optionsFile, JSON.stringify(options));
  const launch = await runProcess(process.execPath, [launcher, optionsFile], { cwd: options.root, timeoutMs: 15_000 });
  assert.equal(launch.code, 0);
  assert.equal(isAlive(launch.pid), false, 'launcher has not exited');
  const state = await backgroundStatus(options.dataDir);
  assert.equal(state.status, 'running');
  assert.equal(state.processAlive, true, 'detached worker stopped with launcher');
  await assert.rejects(() => startBackground(options), /уже работает/);
  await assert.rejects(() => recoverBackground(options.dataDir, options.dbFile), /живой/);
  const deadline = Date.now() + 5000;
  let task;
  while (Date.now() < deadline) {
    task = (await readTasks(options.dbFile)).tasks[0];
    if (task?.childPid) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(task?.childPid, 'fixture child did not start');
  const stopped = await stopBackground(options.dataDir);
  assert.equal(stopped.status, 'interrupted');
  assert.equal(isAlive(task.childPid), false, 'native child survived cooperative stop');
  const db = await readTasks(options.dbFile);
  assert.equal(db.tasks[0].status, 'interrupted');
  assert.equal(db.tasks[1].status, 'queued');
});

test('a background plan completes and restarting does not execute accepted tasks again', async t => {
  const options = await setup(t, ['first', 'second']);
  await startBackground(options);
  assert.equal((await waitUntilStopped(options.dataDir)).status, 'completed');
  await startBackground(options);
  assert.equal((await waitUntilStopped(options.dataDir)).status, 'completed');
  const db = await readTasks(options.dbFile);
  assert.equal(db.tasks.length, 2);
  assert.ok(db.tasks.every(task => task.attempts === 1));
  assert.equal(db.controller.deadlineAt, null);
});

test('background failures are persisted and leave subsequent tasks queued', async t => {
  const options = await setup(t, ['no-report', 'next']);
  await startBackground(options);
  const state = await waitUntilStopped(options.dataDir);
  assert.equal(state.status, 'failed');
  assert.equal(state.exitCode, 1);
  const db = await readTasks(options.dbFile);
  assert.deepEqual(db.tasks.map(task => task.status), ['failed', 'queued']);
});

test('foreign-host service metadata cannot stop or recover an unknown process', async t => {
  const options = await setup(t, ['first']);
  const file = path.join(options.dataDir, 'service.json');
  const original = { id: randomUUID(), pid: process.pid, host: 'synthetic-other-host', status: 'running' };
  await writeTasks(original, file);
  assert.equal((await backgroundStatus(options.dataDir)).status, 'unknown');
  await assert.rejects(() => stopBackground(options.dataDir), /не подтверждена/);
  await assert.rejects(() => recoverBackground(options.dataDir, options.dbFile), /неподтверждённый/);
  await assert.rejects(() => startBackground(options), /не подтверждена/);
});

test('missing PID or invalid identity cannot authorize background recovery or a stop request', async t => {
  const options = await setup(t, ['first']);
  for (const metadata of [{ id: randomUUID(), pid: null }, { id: '../bad', pid: process.pid }]) {
    await writeTasks({ ...metadata, host: os.hostname(), status: 'running' }, path.join(options.dataDir, 'service.json'));
    assert.equal((await backgroundStatus(options.dataDir)).status, 'unknown');
    await assert.rejects(() => stopBackground(options.dataDir), /не подтверждена/);
    await assert.rejects(() => recoverBackground(options.dataDir, options.dbFile), /неподтверждённый/);
  }
});
