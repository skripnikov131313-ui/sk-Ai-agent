import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readTasks, updateTask } from '../src/store.mjs';
import { parsePlan, work } from '../src/work.mjs';

const fixture = fileURLToPath(new URL('./fixtures/work-codex.mjs', import.meta.url));

async function setup(t, cases) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'work-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'PLAN.md'), `# Plan\n\n${cases.map(item => `- [ ] CASE=${item}`).join('\n')}\n`);
  const dataDir = path.join(root, '.skai-agent');
  const dbFile = path.join(dataDir, 'tasks.json');
  return { root, dataDir, dbFile, source: 'PLAN.md', command: process.execPath,
    prefixArgs: [fixture], budgetMs: 20_000, taskTimeoutMs: 5000, graceMs: 50 };
}

async function invocations(root) {
  try { return (await readFile(path.join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('one work launch executes successive checklist items and a restart does not repeat them', async t => {
  const options = await setup(t, ['first', 'second', 'third']);
  const events = [];
  const first = await work({ ...options, onProgress: event => events.push(event.type) });
  assert.equal(first.exitCode, 0);
  assert.equal(first.tasks.length, 3);
  assert.ok(first.tasks.every(task => task.status === 'completed' && task.work.verified));
  assert.deepEqual(events, ['starting', 'completed', 'starting', 'completed', 'starting', 'completed']);
  assert.equal((await work(options)).exitCode, 0);
  assert.equal((await invocations(options.root)).length, 3);
  assert.equal((await readTasks(options.dbFile)).controller.pid, null);
});

test('an unverified success is resumed automatically before advancing', async t => {
  const options = await setup(t, ['repair', 'next']);
  const result = await work(options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual((await invocations(options.root)).map(item => item.text), ['CASE=repair', 'CASE=repair', 'CASE=next']);
  assert.ok((await invocations(options.root))[1].args.includes('resume'));
  assert.equal(result.tasks[0].attempts, 2);
});

test('an explicit failed report resumes in the saved session with bounded attempts', async t => {
  const options = await setup(t, ['failed']);
  const result = await work(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.tasks[0].attempts, 2);
});

test('a completed checkpoint without work acceptance is verified again after restart', async t => {
  const options = await setup(t, ['first']);
  const first = await work(options);
  const task = first.tasks[0];
  await updateTask(task.id, { work: { ...task.work, verified: false },
    report: { ...task.report, checks: [] } }, options.dbFile);
  const next = await work(options);
  assert.equal(next.exitCode, 0);
  assert.equal(next.tasks[0].attempts, 2);
  assert.equal(next.tasks[0].work.verified, true);
  assert.equal((await invocations(options.root)).length, 2);
});

test('a blocker is recorded and independent tasks continue without retrying it', async t => {
  const options = await setup(t, ['blocked', 'next']);
  const result = await work(options);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.tasks.map(task => task.status), ['blocked', 'completed']);
  await work(options);
  assert.deepEqual((await invocations(options.root)).map(item => item.text), ['CASE=blocked', 'CASE=next']);
});

test('retrying blocked work requires the explicit option and respects the attempt limit', async t => {
  const options = await setup(t, ['blocked']);
  await work(options);
  await work(options);
  assert.equal((await invocations(options.root)).length, 1);
  await work({ ...options, retryBlocked: true });
  await work({ ...options, retryBlocked: true });
  await work({ ...options, retryBlocked: true });
  assert.equal((await invocations(options.root)).length, 3);
});

test('a missing report stops the launch without burning retries or starting subsequent items', async t => {
  const options = await setup(t, ['no-report', 'next']);
  const result = await work(options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.tasks[0].attempts, 1);
  assert.equal(result.tasks[1].status, 'queued');
  assert.equal((await invocations(options.root)).length, 1);
});

test('repeated acceptance failure is capped and remains capped after restart', async t => {
  const options = await setup(t, ['incomplete', 'next']);
  const result = await work(options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.tasks[0].attempts, 3);
  assert.equal(result.tasks[1].status, 'completed');
  await work(options);
  assert.equal((await invocations(options.root)).length, 4);
});

test('the finite snapshot excludes new model-added items until another explicit launch', async t => {
  const options = await setup(t, ['grow']);
  const result = await work(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.tasks.length, 1);
  assert.equal((await invocations(options.root)).length, 1);
  assert.match(await readFile(path.join(options.root, 'PLAN.md'), 'utf8'), /\[ \] CASE=unplanned/);
});

test('the launch item limit preserves remaining work for a later launch', async t => {
  const options = await setup(t, ['first', 'second', 'third']);
  const first = await work({ ...options, maxTasks: 2 });
  assert.equal(first.tasks.length, 2);
  assert.equal(first.status, 'paused');
  assert.equal((await invocations(options.root)).length, 2);
  const next = await work({ ...options, maxTasks: 2 });
  assert.equal(next.tasks.length, 1);
  assert.equal((await invocations(options.root)).length, 3);
});

test('overall time budget interrupts the child and does not start the next item', async t => {
  const options = await setup(t, ['hold', 'next']);
  const result = await work({ ...options, budgetMs: 500 });
  assert.equal(result.exitCode, 124);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.tasks[0].status, 'interrupted');
  assert.equal(result.tasks[1].status, 'queued');
});

test('a per-attempt timeout resumes the saved session and then advances automatically', async t => {
  const options = await setup(t, ['timeout', 'next']);
  const result = await work({ ...options, taskTimeoutMs: 1200 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual((await invocations(options.root)).map(item => item.text), ['CASE=timeout', 'CASE=timeout', 'CASE=next']);
  assert.ok((await invocations(options.root))[1].args.includes('resume'));
});

test('abort cancels the active worker and prevents the next item and concurrent launch', async t => {
  const options = await setup(t, ['hold', 'next']);
  const controller = new AbortController();
  const running = work({ ...options, signal: controller.signal });
  t.after(async () => { controller.abort(); await running.catch(() => {}); });
  const deadline = Date.now() + 5000;
  while (!(await invocations(options.root)).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await invocations(options.root)).length, 1);
  await assert.rejects(() => work(options), /уже работает/);
  controller.abort();
  const result = await running;
  assert.equal(result.exitCode, 130);
  assert.equal(result.tasks[0].status, 'interrupted');
  assert.equal(result.tasks[1].status, 'queued');
  assert.equal((await invocations(options.root)).length, 1);
});

test('a running task left behind is never executed again without explicit recovery', async t => {
  const options = await setup(t, ['no-report']);
  const first = await work(options);
  await updateTask(first.tasks[0].id, { status: 'running' }, options.dbFile);
  const second = await work(options);
  assert.equal(second.exitCode, 2);
  assert.match(second.reason, /work-recover/);
  assert.equal((await invocations(options.root)).length, 1);
});

test('plan parsing preserves identity when checked, ignores fenced examples, and rejects ambiguous items', () => {
  const source = '# Plan\r\n\n- [ ] First\n```md\n~~~\n- [ ] Example\n```\n## Other\n- [x] First\n  - [ ] Nested\n';
  const items = parsePlan(source);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
  assert.equal(items[0].key, parsePlan(source.replace('[ ] First', '[x] First'))[0].key);
  assert.throws(() => parsePlan('# Plan\n- [ ] Same\n- [x] Same'), /неоднозначны/);
});

test('unsafe plan paths and unbounded work limits are rejected before any worker starts', async t => {
  const options = await setup(t, ['first']);
  await assert.rejects(() => work({ ...options, source: '../outside.md' }), /внутри проекта/);
  await assert.rejects(() => work({ ...options, budgetMs: Infinity }), /Лимиты/);
  await assert.rejects(() => work({ ...options, maxAttempts: 4 }), /Лимиты/);
  assert.equal((await invocations(options.root)).length, 0);
});
