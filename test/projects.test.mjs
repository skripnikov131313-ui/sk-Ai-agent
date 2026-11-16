import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, readTasks, updateTask } from '../src/store.mjs';
import { findExecutable } from '../src/doctor.mjs';
import { runProcess } from '../src/process.mjs';
import { executeTask } from '../src/runner.mjs';
import { assertProjectContext, bindProjectStore, inspectProject, loadProjectCatalog, readProjectRegistry, registerProject } from '../src/projects.mjs';
import { createAgentServer } from '../src/web/server.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const git = await findExecutable('git', process.env, { nativeOnly: true });
async function gitAt(root, ...args) {
  assert.ok(git, 'Git is required by the project registry');
  const result = await runProcess(git, ['-C', root, ...args], { cwd: root, timeoutMs: 10_000 });
  assert.equal(result.code, 0, 'local Git command must succeed');
}

async function setup(t, mode) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const base = await realpath(await mkdtemp(path.join(parent, 'projects-')));
  const appRoot = path.join(base, 'agent');
  const browserRoot = path.join(base, 'browser');
  const otherRoot = path.join(base, 'other');
  for (const root of [appRoot, browserRoot, otherRoot]) await mkdir(root);
  for (const root of [browserRoot, otherRoot]) await gitAt(root, 'init', '--quiet');
  await gitAt(browserRoot, 'remote', 'add', 'origin', 'https://github.com/example/browser.git');
  const appDataDir = path.join(appRoot, '.skai-agent');
  const registryFile = path.join(appDataDir, 'projects.json');
  const register = (id = 'browser', root = browserRoot, name = 'Sk/Ai Browser') => registerProject({ id, name, root, appRoot, appDataDir });
  let app;
  if (mode) {
    await register();
    await register('other', otherRoot, 'Другой проект');
    app = await createAgentServer({ root: appRoot, command: process.execPath, prefixArgs: [fixture, mode], timeoutMs: 5000, graceMs: 50 });
  }
  t.after(async () => { if (app) await app.close(); await rm(base, { recursive: true, force: true }); });
  const catalog = () => loadProjectCatalog({ root: appRoot });
  const context = async (id = 'browser') => (await catalog()).find(project => project.id === id).context;
  const api = async (endpoint, { data, project = 'agent', scope = true, headers = {} } = {}) => {
    const selected = app.projects.find(item => item.id === project);
    const response = await fetch(app.origin + endpoint, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-SkAi-Client': 'operator-ui', 'X-SkAi-Project': project, Origin: app.origin,
        ...(scope && selected ? { 'X-SkAi-Project-Scope': selected.scope } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const add = (project, goal = `Задача проекта ${project}`, requestId = randomUUID()) => api('/api/tasks', { project, data: { goal, requestId } });
  return { base, appRoot, appDataDir, browserRoot, otherRoot, registryFile, register, catalog, context, app, api, add };
}

async function eventually(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('project queue did not reach its expected state');
}

test('registration canonicalizes local Git roots, strips remote credentials, and keeps stable scopes on rename', async t => {
  const { browserRoot, register, registryFile, catalog } = await setup(t);
  await gitAt(browserRoot, 'remote', 'set-url', 'origin', 'https://SYNTHETIC_PRIVATE_USER:SYNTHETIC_PRIVATE_PASSWORD@github.com/Example/Browser.git?token=SYNTHETIC_PRIVATE_QUERY');
  await register();
  const [agent, browser] = await catalog();
  assert.equal(browser.repository, 'github.com/example/browser');
  assert.equal(browser.root, await realpath(browserRoot));
  assert.match(browser.scope, /^[a-f0-9]{64}$/);
  assert.notEqual(agent.scope, browser.scope);
  assert.doesNotMatch(await readFile(registryFile, 'utf8'), /SYNTHETIC_PRIVATE|token=/);
  await register('browser', browserRoot, 'Новое название');
  const renamed = (await catalog())[1];
  assert.equal(renamed.scope, browser.scope);
  assert.equal(renamed.name, 'Новое название');
});

test('concurrent local registrations preserve both records and a project ID cannot be retargeted', async t => {
  const { register, otherRoot, registryFile } = await setup(t);
  await Promise.all([register(), register('other', otherRoot, 'Другой')]);
  const before = await readFile(registryFile, 'utf8');
  assert.deepEqual((await readProjectRegistry(registryFile)).projects.map(project => project.id).sort(), ['browser', 'other']);
  await assert.rejects(register('browser', otherRoot, 'Подмена'), /ID проекта уже связан/);
  assert.equal(await readFile(registryFile, 'utf8'), before);
});

test('registration rejects non-Git, nested, overlapping, unsupported-origin and unsafe-name projects', async t => {
  const { appRoot, browserRoot, register } = await setup(t);
  await assert.rejects(register('empty', appRoot), /корень отдельного Git/);
  const child = path.join(browserRoot, 'child'); await mkdir(child);
  await assert.rejects(register('child', child), /корень отдельного Git/);
  await register();
  await assert.rejects(register('duplicate'), /пересекаются/);
  await assert.rejects(register('agent'), /Нужны ID/);
  await assert.rejects(register('../outside'), /Нужны ID/);
  await assert.rejects(register('secret', browserRoot, 'password="SYNTHETIC_PRIVATE"'), /Нужны ID/);
  await gitAt(browserRoot, 'remote', 'set-url', 'origin', 'https://example.invalid/owner/repo');
  await assert.rejects(inspectProject(browserRoot), /Origin проекта/);
  await gitAt(appRoot, 'init', '--quiet');
  await assert.rejects(register('own', appRoot), /отдельную рабочую папку/);
});

test('a damaged or oversized registry is preserved instead of being replaced', async t => {
  const { register, registryFile, appDataDir } = await setup(t);
  await mkdir(appDataDir);
  for (const damaged of ['{broken', 'x'.repeat(65_537), '{"version":1,"projects":[],"extra":true}']) {
    await writeFile(registryFile, damaged);
    await assert.rejects(register(), /реестр|Реестр/);
    assert.equal(await readFile(registryFile, 'utf8'), damaged);
  }
});

test('registry and central state symlinks cannot redirect project files', async t => {
  const { register, appDataDir, otherRoot, registryFile, context } = await setup(t);
  await mkdir(appDataDir);
  const external = path.join(otherRoot, 'registry.json');
  await writeFile(external, '{"version":1,"projects":[]}');
  await symlink(external, registryFile, 'file').catch(error => { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; });
  try { await access(registryFile); await assert.rejects(register(), /реестр/); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(registryFile, { force: true });
  await register();
  const project = await context();
  await mkdir(path.dirname(project.dataDir), { recursive: true });
  await symlink(otherRoot, project.dataDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertProjectContext(project), /символической ссылкой/);
  assert.equal(await readFile(external, 'utf8'), '{"version":1,"projects":[]}');
});

test('a bound or populated unbound queue is never silently adopted by another project', () => {
  const project = { id: 'browser', scope: 'a'.repeat(64) };
  const db = { version: 1, tasks: [] };
  bindProjectStore(db, project);
  assert.deepEqual(db.projectBinding, project);
  assert.throws(() => bindProjectStore(db, null), /другому проекту/);
  assert.throws(() => bindProjectStore(db, { ...project, scope: 'b'.repeat(64) }), /другому проекту/);
  assert.throws(() => bindProjectStore({ tasks: [{ id: randomUUID() }] }, project), /нет подтверждённой привязки/);
  assert.doesNotThrow(() => bindProjectStore({ tasks: [{ id: randomUUID() }] }, null));
});

test('the public catalog exposes known project IDs without filesystem paths or credentials', async t => {
  const { api, appRoot, browserRoot } = await setup(t, 'completed');
  const result = await api('/api/projects');
  assert.equal(result.status, 200);
  assert.equal(result.body.defaultProjectId, 'agent');
  assert.deepEqual(result.body.projects.map(project => project.id), ['agent', 'browser', 'other']);
  assert.deepEqual(Object.keys(result.body.projects[1]).sort(), ['id', 'name', 'repository', 'scope']);
  assert.ok(!JSON.stringify(result.body).includes(appRoot));
  assert.ok(!JSON.stringify(result.body).includes(browserRoot));
  assert.equal((await api('/api/projects', { data: { root: browserRoot } })).status, 404);
});

test('project ID and scope checks reject missing, stale, unknown or malformed selection without mutations', async t => {
  const { api, context } = await setup(t, 'completed');
  const data = { goal: 'Не должен попасть в другую очередь', requestId: randomUUID() };
  assert.equal((await api('/api/tasks', { data, project: 'browser', scope: false })).status, 409);
  assert.equal((await api('/api/tasks', { data, project: 'browser', headers: { 'X-SkAi-Project-Scope': 'stale' } })).status, 409);
  assert.equal((await api('/api/state', { project: 'browser', headers: { 'X-SkAi-Project-Scope': 'stale' } })).status, 409);
  assert.equal((await api('/api/tasks', { data, project: 'unknown' })).status, 404);
  assert.equal((await api('/api/tasks', { data, project: '../outside' })).status, 400);
  assert.equal((await api('/api/tasks', { project: 'browser', data: { ...data, root: ROOT } })).status, 400);
  assert.equal((await readTasks((await context()).dbFile)).tasks.length, 0);
});

test('tasks, dependencies, details and idempotency are scoped to the selected queue', async t => {
  const { api, add } = await setup(t, 'completed');
  const requestId = randomUUID();
  const agent = (await add('agent', 'Задание для Agent', requestId)).body.task;
  const browser = (await add('browser', 'Задание для Browser', requestId)).body.task;
  assert.notEqual(agent.id, browser.id);
  assert.equal((await add('browser', 'Задание для Browser', requestId)).body.task.id, browser.id);
  assert.deepEqual((await api('/api/state', { project: 'browser' })).body.tasks.map(task => task.id), [browser.id]);
  assert.deepEqual((await api('/api/state')).body.tasks.map(task => task.id), [agent.id]);
  assert.equal((await api(`/api/tasks/${agent.id}`, { project: 'browser' })).status, 404);
  assert.equal((await api(`/api/tasks/${agent.id}/resume`, { project: 'browser', data: {} })).status, 404);
  assert.equal((await api('/api/tasks', { project: 'browser', data: { goal: 'Чужой предшественник', requestId: randomUUID(), dependsOn: [agent.id] } })).status, 400);
  assert.equal((await api('/api/tasks', { project: 'browser', data: { goal: 'Свой предшественник', requestId: randomUUID(), dependsOn: [browser.id] } })).status, 201);
});

test('a registered project executes in its own root and keeps reports and queue under Agent state', async t => {
  const { appRoot, browserRoot, context, api, add } = await setup(t, 'completed');
  const task = (await add('browser')).body.task;
  const project = await context();
  assert.equal((await api('/api/queue/start', { project: 'browser', data: {} })).status, 202);
  await eventually(async () => !(await api('/api/state', { project: 'browser' })).body.ownedRun);
  const db = await readTasks(project.dbFile);
  assert.equal(db.tasks[0].id, task.id);
  assert.equal(db.tasks[0].status, 'completed');
  assert.equal(db.tasks[0].attempts, 1);
  assert.deepEqual(db.projectBinding, { id: 'browser', scope: project.scope });
  assert.equal(await readFile(path.join(browserRoot, 'fixture-result.txt'), 'utf8'), 'protocol fixture changed this file\n');
  await assert.rejects(access(path.join(appRoot, 'fixture-result.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(browserRoot, '.skai-agent')), { code: 'ENOENT' });
  const invocation = JSON.parse(await readFile(path.join(browserRoot, 'invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, browserRoot);
  assert.equal(invocation.args[invocation.args.indexOf('--cd') + 1], browserRoot);
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(invocation.args[invocation.args.indexOf('--output-last-message') + 1].startsWith(project.dataDir + path.sep));
  assert.equal((await readTasks(path.join(appRoot, '.skai-agent', 'tasks.json'))).tasks.length, 0);
});

test('copying another queue is rejected by the API and direct runner without overwriting its contents', async t => {
  const { add, context, api, appRoot } = await setup(t, 'completed');
  const task = (await add('browser')).body.task;
  const browser = await context(); const other = await context('other');
  await mkdir(other.dataDir, { recursive: true });
  await copyFile(browser.dbFile, other.dbFile);
  const before = await readFile(other.dbFile, 'utf8');
  assert.equal((await api('/api/state', { project: 'other' })).status, 409);
  assert.equal((await add('other')).status, 409);
  assert.equal((await api('/api/queue/start', { project: 'other', data: {} })).status, 409);
  await assert.rejects(executeTask(task.id, false, { root: appRoot, dataDir: browser.dataDir, dbFile: browser.dbFile, command: process.execPath, prefixArgs: [fixture, 'completed'] }), /другому проекту/);
  assert.equal(await readFile(other.dbFile, 'utf8'), before);
  assert.equal((await readTasks(browser.dbFile)).tasks[0].attempts, 0);
});

test('changed origin disables execution without spending attempts while preserving queue inspection', async t => {
  const { add, api, browserRoot, context } = await setup(t, 'completed');
  await add('browser');
  await gitAt(browserRoot, 'remote', 'set-url', 'origin', 'https://github.com/example/different.git');
  const state = await api('/api/state', { project: 'browser' });
  assert.equal(state.status, 200);
  assert.equal(state.body.executionEnabled, false);
  assert.match(state.body.workspaceError, /origin/);
  assert.equal((await api('/api/queue/start', { project: 'browser', data: {} })).status, 409);
  assert.equal((await add('browser', 'Сохранить следующий шаг до восстановления папки')).status, 201);
  const db = await readTasks((await context()).dbFile);
  assert.ok(db.tasks.every(task => task.attempts === 0));
  await assert.rejects(access(path.join(browserRoot, 'invocation.json')), { code: 'ENOENT' });
  assert.equal((await api('/api/state')).body.executionEnabled, true);
});

test('a registry edit invalidates an already open project instead of silently redirecting it', async t => {
  const { add, api, registryFile, otherRoot, context } = await setup(t, 'completed');
  await add('browser');
  const project = await context();
  const before = await readFile(project.dbFile, 'utf8');
  const registry = await readProjectRegistry(registryFile);
  Object.assign(registry.projects[0], await inspectProject(otherRoot));
  registry.projects = [registry.projects[0]];
  await writeFile(registryFile, JSON.stringify(registry));
  assert.equal((await api('/api/state', { project: 'browser' })).status, 409);
  assert.equal((await api('/api/queue/start', { project: 'browser', data: {} })).status, 409);
  assert.equal(await readFile(project.dbFile, 'utf8'), before);
  await assert.rejects(access(path.join(otherRoot, 'invocation.json')), { code: 'ENOENT' });
});

test('one UI server runs only one project queue and stopping another project cannot stop it', async t => {
  const { api, add, context } = await setup(t, 'hold');
  await add('agent'); await add('browser');
  assert.equal((await api('/api/queue/start', { data: {} })).status, 202);
  await eventually(async () => (await api('/api/state')).body.tasks[0].status === 'running');
  const state = (await api('/api/state', { project: 'browser' })).body;
  assert.equal(state.otherActiveProject.id, 'agent');
  assert.equal(state.ownedRun, false);
  assert.equal((await api('/api/queue/start', { project: 'browser', data: {} })).status, 409);
  assert.equal((await api('/api/queue/stop', { project: 'browser', data: {} })).status, 202);
  assert.equal((await api('/api/state')).body.ownedRun, true);
  assert.equal((await readTasks((await context()).dbFile)).tasks[0].attempts, 0);
  await api('/api/queue/stop', { data: {} });
  await eventually(async () => !(await api('/api/state')).body.ownedRun);
  assert.equal((await api('/api/state')).body.tasks[0].status, 'interrupted');
  assert.equal((await api('/api/queue/start', { project: 'browser', data: {} })).status, 202);
  await eventually(async () => (await api('/api/state', { project: 'browser' })).body.tasks[0].status === 'running');
  await api('/api/queue/stop', { project: 'browser', data: {} });
  await eventually(async () => !(await api('/api/state', { project: 'browser' })).body.ownedRun);
  assert.equal((await readTasks((await context()).dbFile)).tasks[0].status, 'interrupted');
});

test('project memory and saved-session resume use the selected root and central queue only', async t => {
  const { add, api, context, appRoot, browserRoot } = await setup(t, 'completed');
  await copyFile(path.join(ROOT, 'MEMORY.json'), path.join(appRoot, 'MEMORY.json'));
  await add('agent');
  const task = (await add('browser')).body.task;
  const project = await context();
  await updateTask(task.id, { status: 'interrupted', attempts: 1, sessionId: '12345678-1234-4321-8123-123456789abc' }, project.dbFile);
  const memory = (await api('/api/memory', { project: 'browser' })).body;
  assert.equal(memory.available, false);
  assert.equal(memory.lessons.length, 0);
  assert.equal(memory.outcomes.queue.total, 1);
  assert.equal((await api('/api/memory')).body.available, true);
  assert.equal((await api(`/api/tasks/${task.id}/resume`, { project: 'browser', data: {} })).status, 202);
  await eventually(async () => !(await api('/api/state', { project: 'browser' })).body.ownedRun);
  assert.equal((await readTasks(project.dbFile)).tasks[0].attempts, 2);
  assert.equal((await readTasks(project.dbFile)).tasks[0].status, 'completed');
  const invocation = JSON.parse(await readFile(path.join(browserRoot, 'invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, browserRoot);
  assert.ok(invocation.args.includes('resume'));
  assert.equal((await api('/api/state')).body.tasks[0].attempts, 0);
});
