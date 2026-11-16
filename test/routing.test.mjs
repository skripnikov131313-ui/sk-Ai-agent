import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, addTask, newTask, readTasks, updateTask, writeTasks } from '../src/store.mjs';
import { executeTask } from '../src/runner.mjs';
import { createWorkerProfile, evaluateTaskRoute, reconcileWaitingTasks, taskRequirements } from '../src/routing.mjs';
import { parseTaskOptions } from '../src/task-options.mjs';

const linux = createWorkerProfile({ platform: 'linux' });
const windows = createWorkerProfile({ platform: 'win32' });
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function setup(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'routing-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.skai-agent');
  return { root, dataDir, dbFile: path.join(dataDir, 'tasks.json'), command: process.execPath,
    prefixArgs: [fixture, 'completed'], timeoutMs: 5000, graceMs: 50 };
}

test('requirements and CLI options validate targets and canonicalize existing task IDs', () => {
  const id = randomUUID();
  assert.deepEqual(taskRequirements(), { target: 'current', dependsOn: [] });
  assert.deepEqual(taskRequirements({ target: 'windows', dependsOn: [id.toUpperCase(), id] }), { target: 'windows', dependsOn: [id] });
  assert.deepEqual(parseTaskOptions(['--target', 'windows-gui', '--after', id, 'Проверить', 'окно']),
    { goal: 'Проверить окно', requirements: { target: 'windows-gui', dependsOn: [id] } });
  assert.equal(parseTaskOptions(['--', '--literal goal']).goal, '--literal goal');
  for (const args of [['--target'], ['--target', 'remote'], ['--after', 'wrong'], ['--unknown']]) assert.throws(() => parseTaskOptions(args));
  for (const dependsOn of [null, 'id', [7], [null], Array(33).fill(id)]) assert.throws(() => taskRequirements({ dependsOn }));
  assert.throws(() => createWorkerProfile({ platform: 'linux', desktop: true }), /только на Windows/);
});

test('dependencies must exist in the same queue and rejected writes preserve its contents', async t => {
  const options = await setup(t);
  const parent = await addTask('Сначала проверить настройки', options.dbFile, {}, linux);
  const before = await readFile(options.dbFile, 'utf8');
  await assert.rejects(() => addTask('Задача с неизвестным предшественником', options.dbFile, { dependsOn: [randomUUID()] }, linux), /не найдена/);
  assert.equal(await readFile(options.dbFile, 'utf8'), before);
  const child = await addTask('Затем проверить сохранение', options.dbFile, { dependsOn: [parent.id] }, linux);
  assert.equal(child.status, 'waiting');
  assert.equal(child.waitingReason.code, 'dependency');
  assert.equal(child.attempts, 0);
});

test('routing reports platform, desktop, damaged and unsuccessful dependency requirements', () => {
  const parent = newTask('Подготовить исходные данные');
  const child = newTask('Проверить готовые данные', { dependsOn: [parent.id] });
  assert.equal(evaluateTaskRoute(child, [parent, child], linux).code, 'dependency');
  parent.status = 'blocked';
  assert.equal(evaluateTaskRoute(child, [parent, child], linux).code, 'blocked-dependency');
  parent.status = 'completed';
  assert.equal(evaluateTaskRoute(child, [parent, child], linux).eligible, true);
  parent.report = { status: 'completed', blockers: ['historical contradiction'] };
  assert.equal(evaluateTaskRoute(child, [parent, child], linux).code, 'blocked-dependency');
  delete parent.report;
  assert.equal(evaluateTaskRoute(child, [child], linux).code, 'missing-dependency');
  assert.equal(evaluateTaskRoute({ ...child, dependsOn: null }, [child], linux).code, 'invalid-requirements');
  const gui = newTask('Проверить настоящее окно', { target: 'windows-gui' });
  assert.equal(evaluateTaskRoute(gui, [gui], linux).code, 'windows');
  assert.equal(evaluateTaskRoute(gui, [gui], windows).code, 'desktop');
  assert.equal(evaluateTaskRoute(gui, [gui], { ...windows, desktop: true }).eligible, true);
});

test('the native adapter cannot run a Windows task on Linux or spend an attempt waiting', async t => {
  const options = await setup(t);
  const task = await addTask('Проверить Windows native API', options.dbFile, { target: 'windows' }, linux);
  for (let index = 0; index < 2; index++) {
    const result = await executeTask(task.id, false, { ...options, command: 'must-never-be-spawned', worker: linux });
    assert.equal(result.exitCode, 3);
    assert.equal(result.outputFile, null);
    assert.equal(result.task.status, 'waiting');
    assert.equal(result.task.attempts, 0);
    assert.equal(result.task.waitingReason.code, 'windows');
    assert.equal(result.task.sessionId, null);
  }
  await assert.rejects(() => readFile(path.join(options.root, 'invocation.json')), { code: 'ENOENT' });
  // An injected Windows profile tests routing only. The child is a Node fixture.
  const result = await executeTask(task.id, false, { ...options, worker: windows });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.attempts, 1);
  assert.equal(result.task.waitingReason, null);
});

test('GUI routing requires both Windows and an operator desktop declaration', async t => {
  const options = await setup(t);
  const task = await addTask('Проверить GUI через тестовый протокол', options.dbFile, { target: 'windows-gui' }, windows);
  assert.equal((await executeTask(task.id, false, { ...options, command: 'must-not-start', worker: windows })).exitCode, 3);
  assert.equal((await readTasks(options.dbFile)).tasks[0].attempts, 0);
  const result = await executeTask(task.id, false, { ...options, worker: { ...windows, desktop: true } });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.attempts, 1);
});

test('direct run and resume enforce unfinished dependencies and preserve a suspended session', async t => {
  const options = await setup(t);
  const parent = await addTask('Подготовить тестовые данные', options.dbFile, {}, linux);
  const child = await addTask('Обработать тестовые данные', options.dbFile, { dependsOn: [parent.id] }, linux);
  assert.equal((await executeTask(child.id, false, { ...options, command: 'must-not-start', worker: linux })).task.attempts, 0);
  const sessionId = randomUUID();
  await updateTask(child.id, { status: 'interrupted', attempts: 1, sessionId }, options.dbFile);
  await assert.rejects(() => executeTask(child.id, true, { ...options, worker: linux }), /Ожидает завершения/);
  const stored = (await readTasks(options.dbFile)).tasks.find(task => task.id === child.id);
  assert.equal(stored.status, 'interrupted');
  assert.equal(stored.attempts, 1);
  assert.equal(stored.sessionId, sessionId);
  await updateTask(parent.id, { status: 'completed' }, options.dbFile);
  await updateTask(parent.id, { report: { status: 'completed', blockers: ['historical contradiction'] } }, options.dbFile);
  await assert.rejects(() => executeTask(child.id, true, { ...options, worker: linux }), /содержит блокеры/);
  assert.equal((await readTasks(options.dbFile)).tasks.find(task => task.id === child.id).attempts, 1);
  await updateTask(parent.id, { report: { status: 'completed', blockers: [] } }, options.dbFile);
  assert.equal((await executeTask(child.id, true, { ...options, worker: linux })).task.status, 'completed');
});

test('legacy tasks remain portable and reconciliation never rewrites running or finished tasks', async t => {
  const options = await setup(t);
  const legacy = newTask('Старая сохранённая задача');
  delete legacy.target; delete legacy.dependsOn;
  const running = { ...newTask('Выполняемая Windows задача', { target: 'windows' }), status: 'running' };
  const completed = { ...newTask('Законченная Windows задача', { target: 'windows' }), status: 'completed' };
  const db = { version: 1, tasks: [legacy, running, completed] };
  reconcileWaitingTasks(db, linux);
  assert.deepEqual(db.tasks.map(task => task.status), ['queued', 'running', 'completed']);
  await writeTasks({ version: 1, tasks: [legacy] }, options.dbFile);
  assert.equal((await executeTask(legacy.id, false, { ...options, worker: linux })).task.status, 'completed');
});
