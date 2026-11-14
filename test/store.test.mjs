import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addTask, DATA_DIR, readTasks, updateTask, recoverStore } from '../src/store.mjs';
import { classifyResult } from '../src/result.mjs';
import { recoverTask } from '../src/runner.mjs';
import { runProcess } from '../src/process.mjs';
import { fileURLToPath } from 'node:url';

async function makeTemp(prefix) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, prefix));
}

test('task creation persists an identified queued task', async () => {
  const dir = await makeTemp('skai-');
  try {
    const file = path.join(dir, 'tasks.json');
    const task = await addTask('Сделать безопасный прототип', file);
    const db = await readTasks(file);
    assert.equal(db.tasks.length, 1);
    assert.equal(db.tasks[0].id, task.id);
    assert.equal(db.tasks[0].status, 'queued');
    assert.equal((await readFile(file, 'utf8')).includes(task.goal), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('empty and oversized tasks are rejected', async () => {
  await assert.rejects(() => addTask('   ', path.join(DATA_DIR, 'unused.json')));
  await assert.rejects(() => addTask('x'.repeat(4001), path.join(DATA_DIR, 'unused.json')));
});

test('unknown task updates do not create phantom records', async () => {
  const dir = await makeTemp('skai-');
  try { await assert.rejects(() => updateTask('missing', { status: 'completed' }, path.join(dir, 'tasks.json'))); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('successful process exit is not enough to mark task complete', () => {
  const blocked = JSON.stringify({ status: 'blocked', summary: 'Нет доступа к файлам.', checks: [], filesChanged: [], blockers: ['локальная команда недоступна'] });
  assert.equal(classifyResult(0, false, blocked).status, 'blocked');
  assert.equal(classifyResult(0, false, 'Не смог выполнить задачу').status, 'failed');
  assert.equal(classifyResult(1, false, blocked).status, 'failed');
  assert.equal(classifyResult(null, true, '').status, 'interrupted');
});

test('concurrent changes do not lose queued tasks or leave temporary files', async t => {
  const dir = await makeTemp('skai-concurrent-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  await Promise.all(Array.from({ length: 16 }, (_, i) => addTask(`Concurrent task ${i}`, file)));
  const db = await readTasks(file);
  assert.equal(db.tasks.length, 16);
  assert.equal(new Set(db.tasks.map(task => task.id)).size, 16);
  assert.deepEqual(await readdir(dir), ['tasks.json']);
});

test('separate CLI processes cannot overwrite each other’s queued tasks', async t => {
  const dir = await makeTemp('skai-processes-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  const writer = fileURLToPath(new URL('./fixtures/queue-writer.mjs', import.meta.url));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    runProcess(process.execPath, [writer, file, String(i)], { timeoutMs: 5000 })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await readTasks(file)).tasks.length, 8);
});

test('malformed database is preserved instead of being replaced with an empty queue', async t => {
  const dir = await makeTemp('skai-corrupt-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  await writeFile(file, '{broken');
  await assert.rejects(() => addTask('Do not replace database', file));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('recovery refuses live owners and restores a stopped task with its session', async t => {
  const dir = await makeTemp('skai-recover-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  const task = await addTask('Recover the interrupted fixture', file);
  const stopped = await runProcess(process.execPath, ['-e', ''], { timeoutMs: 5000 });
  assert.ok(stopped.pid);
  await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await assert.rejects(() => recoverStore(file), /остановку/);
  await writeFile(`${file}.lock`, JSON.stringify({ pid: stopped.pid, host: os.hostname() }));
  assert.equal(await recoverStore(file), true);
  assert.equal(await recoverStore(file), false);
  await updateTask(task.id, { status: 'running', workerPid: stopped.pid, childPid: stopped.pid,
    workerHost: os.hostname(), sessionId: '12345678-1234-4321-8123-123456789abc' }, file);
  const recovered = await recoverTask(task.id, file);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.sessionId, '12345678-1234-4321-8123-123456789abc');
  assert.equal(recovered.workerPid, null);
});

test('foreign-host or unknown-process recovery never assumes an old worker stopped', async t => {
  const dir = await makeTemp('skai-host-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  const task = await addTask('Do not start duplicate work', file);
  await updateTask(task.id, { status: 'running', workerHost: 'another-host', workerPid: 1, childPid: 1 }, file);
  await assert.rejects(() => recoverTask(task.id, file), /остановку/);
  await updateTask(task.id, { workerHost: os.hostname(), childPid: null }, file);
  await assert.rejects(() => recoverTask(task.id, file), /остановку/);
  assert.equal((await readTasks(file)).tasks[0].status, 'running');
});

test('report arrays must contain strings and unknown fields cannot be accepted', () => {
  const report = { status: 'completed', summary: 'fixture', checks: [], filesChanged: [], blockers: [] };
  assert.equal(classifyResult(0, false, JSON.stringify({ ...report, checks: [42] })).status, 'failed');
  assert.equal(classifyResult(0, false, JSON.stringify({ ...report, unexpected: true })).status, 'failed');
});
