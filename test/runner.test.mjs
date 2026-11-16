import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { addTask, DATA_DIR, readTasks, updateTask } from '../src/store.mjs';
import { executeTask, recoverTask, MAX_ATTEMPTS } from '../src/runner.mjs';
import { runProcess } from '../src/process.mjs';
import { findExecutable, diagnose } from '../src/doctor.mjs';
import { safeStatus } from '../src/privacy.mjs';
import { explainCodexFailure } from '../src/result.mjs';

// fileURLToPath is necessary for drive letters and spaces on Windows.
import { fileURLToPath } from 'node:url';
const fixturePath = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function setup(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'skai-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.skai-agent');
  const dbFile = path.join(dataDir, 'tasks.json');
  const task = await addTask('Test protocol without invoking a model', dbFile);
  const options = { root, dataDir, dbFile, command: process.execPath,
    prefixArgs: [fixturePath, 'completed'], timeoutMs: 5000, graceMs: 100 };
  return { root, dataDir, dbFile, task, options };
}

async function eventually(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('condition did not become true before deadline');
}

test('executor consumes a fresh structured report, sandbox args, and final partial JSONL line', async t => {
  const { root, task, options } = await setup(t);
  const result = await executeTask(task.id, false, options);
  assert.equal(result.task.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.task.sessionId, '12345678-1234-4321-8123-123456789abc');
  assert.match(await readFile(path.join(root, 'fixture-result.txt'), 'utf8'), /protocol fixture/);
  const invocation = JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, root);
  assert.deepEqual(invocation.args.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '--cd', root]);
  assert.equal(invocation.args.at(-1), '-');
  assert.match(invocation.prompt, /Test protocol/);
  const events = await readFile(path.join(path.dirname(result.outputFile), 'events.jsonl'), 'utf8');
  assert.match(events, /turn.completed/);
  assert.doesNotMatch(events, /SYNTHETIC_SECRET|item.completed|thread_id/);
});

for (const [mode, status, exitCode] of [
  ['blocked', 'blocked', 2], ['failed', 'failed', 1], ['bad-report', 'failed', 1],
  ['no-report', 'failed', 1], ['nonzero', 'failed', 7], ['oversized', 'completed', 0],
  ['completed-blockers', 'blocked', 2], ['failed-blockers', 'blocked', 2],
]) {
  test(`executor distinguishes ${mode}`, async t => {
    const { task, options } = await setup(t);
    const result = await executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, mode] });
    assert.equal(result.task.status, status);
    assert.equal(result.exitCode, exitCode);
    if (mode.endsWith('-blockers')) {
      assert.equal(result.task.report.status, mode === 'completed-blockers' ? 'completed' : 'failed');
      assert.deepEqual(result.task.report.blockers, ['synthetic blocker']);
      assert.match(result.task.error, /блокер/);
      assert.equal(result.task.attempts, 1);
      assert.deepEqual(JSON.parse(await readFile(result.outputFile, 'utf8')), result.task.report);
    }
    if (mode === 'oversized') {
      const events = await readFile(path.join(path.dirname(result.outputFile), 'events.jsonl'), 'utf8');
      assert.match(events, /oversized-output/);
      assert.ok(events.length < 2000);
    }
  });
}

test('resume preserves session, uses a new report, and cannot reuse a stale success', async t => {
  const { root, task, dbFile, options } = await setup(t);
  const first = await executeTask(task.id, false, options);
  await updateTask(task.id, { status: 'blocked' }, dbFile);
  const second = await executeTask(task.id, true, { ...options, prefixArgs: [fixturePath, 'no-report'] });
  assert.equal(second.task.status, 'failed');
  assert.equal(second.task.attempts, 2);
  assert.notEqual(first.outputFile, second.outputFile);
  const invocation = JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8'));
  assert.ok(invocation.args.includes('resume'));
  assert.equal(invocation.args.at(-2), first.task.sessionId);
  assert.match(invocation.prompt, /с сохранённого состояния/);
});

test('thread id is checkpointed before exit and the same task cannot start twice', async t => {
  const { task, dbFile, options } = await setup(t);
  const running = executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, 'hold'], timeoutMs: 1800 });
  // Register cleanup first so a failed assertion does not leave a fixture alive.
  t.after(() => running.catch(() => {}));
  await eventually(async () => (await readTasks(dbFile)).tasks[0].sessionId !== null);
  assert.equal((await readTasks(dbFile)).tasks[0].status, 'running');
  await assert.rejects(() => executeTask(task.id, false, options), /уже выполняется/);
  await assert.rejects(() => recoverTask(task.id, dbFile), /остановку/);
  const result = await running;
  assert.equal(result.task.status, 'interrupted');
  assert.equal(result.exitCode, 124);
  assert.ok(result.task.sessionId);
});

test('timeout stops descendants even when POSIX processes ignore SIGTERM', async t => {
  const { root, task, options } = await setup(t);
  const result = await executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, 'tree'], timeoutMs: 2200 });
  assert.equal(result.exitCode, 124);
  assert.ok(Number(await readFile(path.join(root, 'child.pid'), 'utf8')) > 0);
  const size = (await stat(path.join(root, 'heartbeat'))).size;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await stat(path.join(root, 'heartbeat'))).size, size, 'descendant is still executing');
});

test('missing executable is a persisted failure instead of an unhandled spawn/pipe error', async t => {
  const { root, task, options } = await setup(t);
  const result = await executeTask(task.id, false, { ...options, command: path.join(root, 'missing-executable') });
  assert.equal(result.task.status, 'failed');
  assert.equal(result.exitCode, 127);
  assert.match(result.task.error, /ENOENT/);
});

test('attempt limit and traversal/session validation refuse execution', async t => {
  const { task, dbFile, options } = await setup(t);
  await assert.rejects(() => executeTask('../escape', false, options), /UUID/);
  await updateTask(task.id, { attempts: MAX_ATTEMPTS }, dbFile);
  await assert.rejects(() => executeTask(task.id, false, options), /лимит/);
  await updateTask(task.id, { attempts: 0, status: 'blocked', sessionId: '--last' }, dbFile);
  await assert.rejects(() => executeTask(task.id, true, options), /сессии/);
});

test('diagnostics use PATH on this OS and never return login output', async t => {
  const { root, dataDir } = await setup(t);
  assert.ok(await findExecutable('git'));
  const result = await diagnose(root, dataDir);
  assert.equal(result.tools.node, process.execPath);
  assert.ok(result.tools.git);
  assert.ok(['available', 'not confirmed'].includes(result.codexAuthentication));
  assert.doesNotMatch(JSON.stringify(result), /Bearer |sk-[a-z0-9]{16}/i);
});

test('diagnostics redact recognizable credentials', () => {
  const clean = safeStatus('Bearer abc.123 password=hello api_key="world" ghp_abcdefghijk https://alice:pass@example.test');
  assert.doesNotMatch(clean, /abc.123|hello|world|ghp_abcdef|alice:pass/);
});

test('failed reports redact credentials both in database error and retained JSON', async t => {
  const { task, dbFile, options } = await setup(t);
  const result = await executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, 'credential-report'] });
  assert.equal(result.task.status, 'failed');
  const report = JSON.parse(await readFile(result.outputFile, 'utf8'));
  assert.match(report.summary, /REDACTED/);
  assert.doesNotMatch(await readFile(dbFile, 'utf8'), /SYNTHETIC_PASSWORD/);
  assert.doesNotMatch(await readFile(result.outputFile, 'utf8'), /SYNTHETIC_PASSWORD/);
});

test('client authentication failure is actionable without retaining provider payloads', async t => {
  const { task, dbFile, options } = await setup(t);
  const result = await executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, 'auth-error'] });
  assert.equal(result.task.status, 'failed');
  assert.match(result.task.error, /повторного входа/);
  const events = await readFile(path.join(path.dirname(result.outputFile), 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events + await readFile(dbFile, 'utf8'), /SYNTHETIC_PROVIDER_SECRET|Bearer|authentication token/);
});

test('startup diagnostics ignore the harmless alias warning and preserve unknown failures', () => {
  assert.equal(explainCodexFailure('WARNING: proceeding, even though we could not create PATH aliases: Read-only file system'), null);
  assert.match(explainCodexFailure('Error: failed to initialize in-process app-server client: Read-only file system (os error 30)'), /служебные файлы/);
  assert.match(explainCodexFailure('CONNECT tunnel failed, response 403'), /Прокси/);
  assert.equal(explainCodexFailure('An unknown message with arbitrary payload'), null);
});

test('process error and timeout have distinct outcomes', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 100, graceMs: 10 });
  assert.equal(result.reason, 'timeout');
});

test('SIGTERM checkpoints interrupted state and removes the temporary signal handlers', async t => {
  const { task, dbFile, options } = await setup(t);
  const count = process.listenerCount('SIGTERM');
  const running = executeTask(task.id, false, { ...options, prefixArgs: [fixturePath, 'hold'], handleSignals: true });
  t.after(() => running.catch(() => {}));
  await eventually(async () => (await readTasks(dbFile)).tasks[0].sessionId !== null);
  process.emit('SIGTERM');
  const result = await running;
  assert.equal(result.task.status, 'interrupted');
  assert.equal(result.exitCode, 130);
  assert.match(result.task.error, /пользователем/);
  assert.ok((await readTasks(dbFile)).tasks[0].sessionId);
  assert.equal(process.listenerCount('SIGTERM'), count);
});
