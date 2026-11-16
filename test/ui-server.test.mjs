import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, addTask, isAlive, readTasks, transaction, updateTask, writeTasks } from '../src/store.mjs';
import { createAgentServer } from '../src/web/server.mjs';
import { runProcess } from '../src/process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function setup(t, mode = 'completed', extra = {}) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'ui-')));
  const dataDir = path.join(root, '.skai-agent');
  const dbFile = path.join(dataDir, 'tasks.json');
  const options = { root, dataDir, dbFile, command: process.execPath,
    prefixArgs: [fixture, mode], timeoutMs: 5000, graceMs: 50, ...extra };
  const app = await createAgentServer(options);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (endpoint, data, headers = {}) => {
    const response = await fetch(app.origin + endpoint, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-SkAi-Client': 'operator-ui', Origin: app.origin,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { response, body: await response.json() };
  };
  const add = (goal, requestId = randomUUID()) => api('/api/tasks', { goal, requestId });
  return { root, dataDir, dbFile, options, app, api, add };
}

async function eventually(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('condition did not become true before deadline');
}

test('the real HTTP server binds loopback and serves static assets with a restrictive CSP', async t => {
  const { app } = await setup(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  const response = await fetch(app.origin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sk\/Ai Agent/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  for (const file of ['/app.js', '/style.css']) assert.equal((await fetch(app.origin + file)).status, 200);
});

test('the actual CLI starts a paused panel and exits after termination', async t => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'ui', '--paused', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await ended; });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UI CLI startup timeout')), 10_000);
    let text = '';
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      text += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('close', () => { clearTimeout(timer); reject(new Error('UI CLI exited before readiness')); });
  });
  const response = await fetch(origin + '/api/state', { headers: { 'X-SkAi-Client': 'operator-ui' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).executionEnabled, false);
});

test('project memory exposes checked recipes and aggregate outcomes without task or session payloads', async t => {
  const { root, api, dbFile, add } = await setup(t);
  assert.equal((await api('/api/memory')).body.available, false);
  const memoryFile = fileURLToPath(new URL('../MEMORY.json', import.meta.url));
  await writeFile(path.join(root, 'MEMORY.json'), await readFile(memoryFile));
  const task = (await add('Задача для метрики проектной памяти')).body.task;
  await updateTask(task.id, { status: 'completed', attempts: 2, sessionId: 'SYNTHETIC_PRIVATE_SESSION',
    goal: 'SYNTHETIC_PRIVATE_GOAL', acceptance: { kind: 'smoke-file', verified: true } }, dbFile);
  const result = await api('/api/memory');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.available, true);
  assert.ok(result.body.lessons.some(item => item.id === 'blockers-override-completion'));
  assert.ok(result.body.preferences.some(item => item.id === 'quiet-recovery'));
  assert.equal(result.body.outcomes.queue.total, 1);
  assert.equal(result.body.outcomes.queue.extraAttempts, 1);
  assert.equal(result.body.outcomes.queue.verifiedFiles, 1);
  assert.equal(result.body.outcomes.plan.total, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PRIVATE|sessionId|workerPid/);
  assert.equal((await api('/api/memory', undefined, { 'X-SkAi-Client': '' })).response.status, 403);
  assert.equal((await api('/api/memory', {})).response.status, 404);
});

test('invalid memory remains intact and recoverable without spending attempts or breaking queue inspection', async t => {
  const { root, api, add, dbFile } = await setup(t);
  const file = path.join(root, 'MEMORY.json');
  const broken = '{SYNTHETIC_PRIVATE_MEMORY';
  await writeFile(file, broken);
  const result = await api('/api/memory');
  assert.equal(result.response.status, 422);
  assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PRIVATE/);
  await add('Задача после исправления памяти проекта');
  assert.equal((await api('/api/state')).response.status, 200);
  await api('/api/queue/start', {});
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  assert.equal((await readTasks(dbFile)).batch.status, 'failed');
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 0);
  assert.equal(await readFile(file, 'utf8'), broken);
  await assert.rejects(() => readFile(path.join(root, 'invocation.json')), { code: 'ENOENT' });
  await writeFile(file, await readFile(fileURLToPath(new URL('../MEMORY.json', import.meta.url))));
  await api('/api/queue/start', {});
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  assert.equal((await readTasks(dbFile)).tasks[0].status, 'completed');
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 1);
});

test('task submission persists and concurrent retries cannot create duplicate jobs', async t => {
  const { add, dbFile } = await setup(t);
  const key = randomUUID();
  const submitted = await Promise.all([add('Проверить сохранение настроек', key), add('Проверить сохранение настроек', key)]);
  assert.ok(submitted.every(item => item.response.status === 201));
  assert.equal(submitted[0].body.task.id, submitted[1].body.task.id);
  assert.equal((await readTasks(dbFile)).tasks.length, 1);
  assert.equal((await add('Совсем другой результат', key)).response.status, 409);
});

test('requirements are immutable, normalized and part of submission idempotency; dependencies must be existing queue tasks', async t => {
  const { api, dbFile } = await setup(t, 'completed', { worker: { platform: 'linux', desktop: false } });
  const parent = (await api('/api/tasks', { goal: 'Подготовить данные для зависимой задачи', requestId: randomUUID() })).body.task;
  const requestId = randomUUID();
  const input = { goal: 'Проверить окно после подготовки', target: 'windows-gui', dependsOn: [parent.id], requestId };
  const first = await api('/api/tasks', input);
  assert.equal(first.response.status, 201);
  assert.equal(first.body.task.status, 'waiting');
  assert.equal(first.body.task.route.code, 'windows');
  const repeated = await api('/api/tasks', { ...input, dependsOn: [parent.id.toUpperCase(), parent.id] });
  assert.equal(repeated.body.task.id, first.body.task.id);
  for (const change of [{ target: 'current' }, { dependsOn: [] }]) assert.equal((await api('/api/tasks', { ...input, ...change })).response.status, 409);
  for (const invalid of [{ target: 'remote' }, { dependsOn: [randomUUID()] }, { dependsOn: [7] }, { desktop: true }, { worker: { platform: 'win32' } }]) {
    assert.equal((await api('/api/tasks', { goal: 'Отклоняемая задача с неверными требованиями', requestId: randomUUID(), ...invalid })).response.status, 400);
  }
  assert.equal((await readTasks(dbFile)).tasks.length, 2);
  assert.equal((await api(`/api/tasks/${first.body.task.id}`, { target: 'current' })).response.status, 404);
});

test('a batch skips unavailable Windows work, unlocks dependencies and completes all eligible tasks without spending waiting attempts', async t => {
  const { api, dbFile } = await setup(t, 'completed', { worker: { platform: 'linux', desktop: false } });
  const add = async (goal, options = {}) => (await api('/api/tasks', { goal, requestId: randomUUID(), ...options })).body.task;
  const win = await add('Проверить Win32 в соответствующей среде', { target: 'windows' });
  const parent = await add('Подготовить данные для следующего шага');
  const child = await add('Использовать результат первого шага', { dependsOn: [parent.id] });
  const deferred = await add('Проверить результат Windows задачи', { dependsOn: [win.id] });
  // Dependency order does not depend on the physical JSON array order.
  await transaction(dbFile, db => { db.tasks.reverse(); });
  const before = (await api('/api/state')).body;
  assert.equal(before.runnableCount, 1);
  assert.equal(before.worker.platform, 'linux');
  assert.equal((await api('/api/queue/start', {})).response.status, 202);
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'waiting');
  const db = await readTasks(dbFile);
  assert.equal(db.batch.completed, 2);
  assert.equal(db.batch.waiting, 2);
  for (const id of [parent.id, child.id]) assert.equal(db.tasks.find(task => task.id === id).status, 'completed');
  for (const id of [win.id, deferred.id]) {
    assert.equal(db.tasks.find(task => task.id === id).status, 'waiting');
    assert.equal(db.tasks.find(task => task.id === id).attempts, 0);
  }
  const after = (await api('/api/state')).body;
  assert.equal(after.runnableCount, 0);
  assert.equal(after.tasks.find(task => task.id === deferred.id).route.code, 'dependency');
  assert.equal((await api('/api/queue/start', {})).response.status, 202);
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  assert.equal((await readTasks(dbFile)).batch.completed, 0);
});

test('an all-waiting queue releases its lock without spawning and rejects incompatible saved-session resume', async t => {
  const { api, dbFile, root } = await setup(t, 'completed', { command: 'must-never-start', worker: { platform: 'linux', desktop: false } });
  const task = (await api('/api/tasks', { goal: 'Задача исключительно для Windows', target: 'windows', requestId: randomUUID() })).body.task;
  await api('/api/queue/start', {});
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  assert.equal((await readTasks(dbFile)).batch.status, 'waiting');
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 0);
  await assert.rejects(() => readFile(path.join(root, 'invocation.json')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(`${dbFile}.batch.lock`), { code: 'ENOENT' });
  await updateTask(task.id, { status: 'interrupted', attempts: 1, sessionId: randomUUID() }, dbFile);
  assert.equal((await api(`/api/tasks/${task.id}`)).body.task.canResume, false);
  assert.equal((await api(`/api/tasks/${task.id}/resume`, {})).response.status, 409);
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 1);
  assert.equal((await readTasks(dbFile)).tasks[0].status, 'interrupted');
});

test('damaged requirements are displayed as waiting without returning their arbitrary raw values', async t => {
  const { add, api, dbFile } = await setup(t);
  const task = (await add('Задача с повреждёнными требованиями')).body.task;
  await updateTask(task.id, { target: 'SYNTHETIC_PRIVATE_REQUIREMENT', dependsOn: ['SYNTHETIC_PRIVATE_DEPENDENCY'] }, dbFile);
  const detail = (await api(`/api/tasks/${task.id}`)).body.task;
  assert.equal(detail.status, 'waiting');
  assert.equal(detail.route.code, 'invalid-requirements');
  assert.equal(detail.target, 'invalid');
  assert.deepEqual(detail.dependsOn, []);
  assert.doesNotMatch(JSON.stringify((await api('/api/state')).body), /SYNTHETIC_PRIVATE/);
});

test('a queue launch advances automatically and excludes tasks submitted after its snapshot', async t => {
  const { add, api, dbFile, root } = await setup(t, 'slow');
  await add('Первая проверка протокола'); await add('Вторая проверка протокола');
  assert.equal((await api('/api/queue/start', {})).response.status, 202);
  await eventually(async () => (await readTasks(dbFile)).tasks.some(task => task.status === 'running'));
  const later = (await add('Следующая задача из нового запроса')).body.task.id;
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'completed');
  const db = await readTasks(dbFile);
  assert.equal(db.batch.taskIds.length, 2);
  assert.deepEqual(db.tasks.map(task => task.status), ['completed', 'completed', 'queued']);
  assert.equal(db.tasks.find(task => task.id === later).attempts, 0);
  assert.match(await readFile(path.join(root, 'fixture-result.txt'), 'utf8'), /protocol fixture/);
  const details = (await api(`/api/tasks/${db.tasks[0].id}`)).body.task;
  assert.equal(details.report.checks.length, 1);
  assert.ok(details.report.filesChanged.includes('fixture-result.txt'));
});

test('a blocker stops the batch and reports the reason without starting the next task', async t => {
  const { add, api, dbFile } = await setup(t, 'blocked');
  await add('Задача с тестовым блокером'); await add('Задача после блокера');
  await api('/api/queue/start', {});
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'blocked');
  const db = await readTasks(dbFile);
  assert.deepEqual(db.tasks.map(task => task.status), ['blocked', 'queued']);
  assert.equal(db.tasks[1].attempts, 0);
  const detail = (await api(`/api/tasks/${db.tasks[0].id}`)).body.task;
  assert.deepEqual(detail.report.blockers, ['synthetic blocker']);
});

test('a contradictory completion with blockers stops the batch and cannot unlock its dependent task', async t => {
  const { add, api, dbFile } = await setup(t, 'completed-blockers');
  const parent = (await add('Подготовить данные с противоречивым отчётом')).body.task;
  const child = (await api('/api/tasks', { goal: 'Использовать результат предыдущей задачи', dependsOn: [parent.id], requestId: randomUUID() })).body.task;
  const independent = (await add('Следующая независимая задача этого запуска')).body.task;
  await api('/api/queue/start', {});
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  const db = await readTasks(dbFile);
  assert.equal(db.batch.status, 'blocked');
  assert.equal(db.batch.completed, 0);
  const saved = db.tasks.find(task => task.id === parent.id);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.report.status, 'completed');
  for (const id of [child.id, independent.id]) assert.equal(db.tasks.find(task => task.id === id).attempts, 0);
  const waiting = (await api(`/api/tasks/${child.id}`)).body.task;
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.route.code, 'blocked-dependency');
});

test('failed structured work gets at most three saved-session attempts', async t => {
  const { add, api, dbFile } = await setup(t, 'failed');
  const task = (await add('Исправить искусственную тестовую ошибку')).body.task;
  await api('/api/queue/start', {});
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'failed');
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 3);
  assert.equal((await api(`/api/tasks/${task.id}/resume`, {})).response.status, 409);
});

test('a malformed report cannot pass and does not consume retries or launch the rest', async t => {
  const { add, api, dbFile } = await setup(t, 'bad-report');
  await add('Первая задача с неверным отчётом'); await add('Следующая задача');
  await api('/api/queue/start', {});
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'failed');
  const db = await readTasks(dbFile);
  assert.equal(db.tasks[0].attempts, 1);
  assert.equal(db.tasks[1].status, 'queued');
});

test('stop terminates the native child, saves interrupted, and refuses competing launches', async t => {
  const { add, api, dbFile, options } = await setup(t, 'hold');
  await add('Длительная тестовая задача'); await add('Ожидающая тестовая задача');
  await api('/api/queue/start', {});
  const active = await eventually(async () => (await readTasks(dbFile)).tasks.find(task => task.childPid));
  assert.equal((await api('/api/queue/start', {})).response.status, 409);
  assert.equal((await api('/api/queue/recover', {})).response.status, 409);
  const peer = await createAgentServer(options);
  try { await assert.rejects(() => peer.queue.start(), /занята/); } finally { await peer.close(); }
  assert.equal((await api('/api/queue/stop', {})).response.status, 202);
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'interrupted');
  assert.equal(isAlive(active.childPid), false);
  assert.deepEqual((await readTasks(dbFile)).tasks.map(task => task.status), ['interrupted', 'queued']);
});

test('an explicit resume uses its saved session and returns no process or session credentials', async t => {
  const { root, dbFile, api } = await setup(t);
  const task = await addTask('Продолжить сохранённую тестовую задачу', dbFile);
  await updateTask(task.id, { status: 'interrupted', attempts: 1, sessionId: '12345678-1234-4321-8123-123456789abc' }, dbFile);
  const result = await api(`/api/tasks/${task.id}/resume`, {});
  assert.equal(result.response.status, 202);
  assert.doesNotMatch(JSON.stringify(result.body), /workerPid|workerHost|sessionId/);
  await eventually(async () => (await readTasks(dbFile)).batch?.status === 'completed');
  const invocation = JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8'));
  assert.ok(invocation.args.includes('resume'));
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 2);
  assert.equal((await api(`/api/tasks/${task.id}/resume`, {})).response.status, 409);
});

test('the paused UI can save tasks without calling any executable', async t => {
  const { add, api, dbFile } = await setup(t, 'completed', { executionEnabled: false, command: 'not-an-executable' });
  await add('Отложенная пользовательская задача');
  assert.equal((await api('/api/queue/start', {})).response.status, 409);
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 0);
  assert.equal((await api('/api/state')).body.executionEnabled, false);
});

test('the work plan is visible but cannot be executed through the personal queue', async t => {
  const { add, api, dataDir, dbFile } = await setup(t);
  const workFile = path.join(dataDir, 'work', 'tasks.json');
  const planTask = await addTask('Этап рабочего плана', workFile);
  await updateTask(planTask.id, { status: 'blocked', sessionId: '12345678-1234-4321-8123-123456789abc' }, workFile);
  await transaction(workFile, db => { db.controller = { status: 'blocked', reason: 'Тестовый блокер', taskIds: [planTask.id] }; });
  await add('Задача отдельной личной очереди');
  const state = (await api('/api/state')).body;
  assert.equal(state.tasks.length, 1);
  assert.equal(state.plan.tasks.length, 1);
  assert.equal((await api(`/api/tasks/${planTask.id}?source=plan`)).body.task.goal, 'Этап рабочего плана');
  assert.equal((await api(`/api/tasks/${planTask.id}?source=unknown`)).response.status, 400);
  assert.equal((await api(`/api/tasks/${planTask.id}/resume`, {})).response.status, 404);
  assert.equal((await readTasks(workFile)).tasks[0].status, 'blocked');
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 0);
});

test('cross-site requests, forged hosts and requests without the UI header cannot access the API', async t => {
  const { app, api, dbFile } = await setup(t);
  assert.equal((await fetch(app.origin + '/api/state')).status, 403);
  assert.equal((await api('/api/state', undefined, { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await api('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).response.status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(app.origin + '/api/state', { headers: { Host: 'evil.example', 'X-SkAi-Client': 'operator-ui' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await readTasks(dbFile)).tasks.length, 0);
});

test('unsafe bodies, secret-shaped goals and arbitrary execution endpoints are rejected', async t => {
  const { add, api, app, dbFile } = await setup(t);
  assert.equal((await add('tiny')).response.status, 400);
  assert.equal((await add('Запиши password=SYNTHETIC_PASSWORD')).response.status, 400);
  assert.equal((await api('/api/tasks', { goal: 'Обычная задача', requestId: randomUUID(), command: 'untrusted' })).response.status, 400);
  assert.equal((await api('/api/exec', { command: 'untrusted' })).response.status, 404);
  assert.equal((await api('/api/tasks', { goal: 'x'.repeat(21000), requestId: randomUUID() })).response.status, 413);
  assert.equal((await api('/api/queue/start', {}, { 'Content-Type': 'text/plain' })).response.status, 415);
  assert.notEqual((await fetch(app.origin + '/src/store.mjs')).status, 200);
  assert.equal((await readTasks(dbFile)).tasks.length, 0);
});

test('task views redact recognizable credentials and never return native session IDs', async t => {
  const { api, dbFile } = await setup(t);
  const task = await addTask('Диагностика api_key="SYNTHETIC_PRIVATE_KEY"', dbFile);
  await updateTask(task.id, { sessionId: '12345678-1234-4321-8123-123456789abc', status: 'failed',
    acceptance: { kind: 'smoke-file', file: '.skai-agent/proof.txt', verified: true, marker: 'SYNTHETIC_PROOF_MARKER' },
    error: 'Bearer SYNTHETIC_BEARER', report: { status: 'failed', summary: 'password=SYNTHETIC_PASSWORD',
      checks: [], filesChanged: [], blockers: [] } }, dbFile);
  const summary = await api('/api/state');
  const detail = await api(`/api/tasks/${task.id}`);
  const output = JSON.stringify([summary.body, detail.body]);
  assert.doesNotMatch(output, /SYNTHETIC_PRIVATE|SYNTHETIC_BEARER|SYNTHETIC_PASSWORD|SYNTHETIC_PROOF_MARKER|12345678-1234/);
  assert.equal(detail.body.task.hasSession, true);
  assert.equal(detail.body.task.acceptance.verified, true);
});

test('a damaged database is not replaced by submitting a task', async t => {
  const { add, api, dbFile } = await setup(t);
  await mkdir(path.dirname(dbFile), { recursive: true });
  await writeFile(dbFile, '{broken');
  assert.equal((await api('/api/state')).response.status, 500);
  assert.equal((await add('Не перезаписывай повреждённую очередь')).response.status, 500);
  assert.equal(await readFile(dbFile, 'utf8'), '{broken');
});

test('recovery checks stopped PIDs, preserves the saved session and clears only stale owned locks', async t => {
  const { api, dbFile, root } = await setup(t);
  const exited = await runProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: root });
  assert.equal(isAlive(exited.pid), false);
  const task = await addTask('Восстановить задачу остановленного процесса', dbFile);
  await updateTask(task.id, { status: 'running', workerPid: exited.pid, childPid: exited.pid,
    workerHost: os.hostname(), sessionId: '12345678-1234-4321-8123-123456789abc' }, dbFile);
  const db = await readTasks(dbFile);
  db.batch = { id: randomUUID(), status: 'running', taskIds: [task.id], completed: 0, workerPid: exited.pid, workerHost: os.hostname() };
  await writeTasks(db, dbFile);
  await writeFile(`${dbFile}.batch.lock`, JSON.stringify({ pid: exited.pid, host: os.hostname() }));
  assert.equal((await api('/api/queue/recover', {})).response.status, 200);
  const recovered = await readTasks(dbFile);
  assert.equal(recovered.tasks[0].status, 'interrupted');
  assert.equal(recovered.tasks[0].sessionId, '12345678-1234-4321-8123-123456789abc');
  assert.equal(recovered.batch.status, 'interrupted');
});

test('the recovery endpoint preserves a foreign worker and its lock', async t => {
  const { api, dbFile } = await setup(t);
  const task = await addTask('Задача с другой рабочей машины', dbFile);
  await updateTask(task.id, { status: 'running', workerHost: 'synthetic-foreign-host',
    workerPid: process.pid, childPid: process.pid }, dbFile);
  const lock = JSON.stringify({ host: 'synthetic-foreign-host', pid: process.pid });
  await writeFile(`${dbFile}.batch.lock`, lock);
  const original = await readFile(dbFile, 'utf8');
  const result = await api('/api/queue/recover', {});
  assert.equal(result.response.status, 409);
  assert.match(result.body.error, /Остановка прежнего исполнителя не подтверждена/);
  assert.equal(await readFile(dbFile, 'utf8'), original);
  assert.equal(await readFile(`${dbFile}.batch.lock`, 'utf8'), lock);
});
