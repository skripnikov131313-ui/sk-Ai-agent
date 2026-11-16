import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, ROOT, addTask, readTasks } from '../src/store.mjs';
import { executeTask } from '../src/runner.mjs';
import { MemoryError, memoryForTask, readProjectMemory, summarizeOutcomes, validateMemory } from '../src/memory.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const example = () => ({ version: 1,
  preferences: [{ id: 'quiet', rule: 'Продолжай разрешённый план без лишних сообщений.', source: 'Пользователь' }],
  lessons: [{ id: 'fresh-report', title: 'Свежий отчёт', problem: 'Старый файл не подтверждает новую попытку.',
    approach: 'MEMORY_FIXTURE: используй новый файл отчёта.', platforms: [], checks: ['test/runner.test.mjs'] }] });

async function setup(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'memory-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'MEMORY.json'), dataDir: path.join(root, '.skai-agent'), dbFile: path.join(root, '.skai-agent', 'tasks.json') };
}

test('a project without a catalog keeps its existing executor behavior', async t => {
  const { root } = await setup(t);
  const memory = await readProjectMemory(root);
  assert.equal(memory.available, false);
  assert.equal(memoryForTask(memory, 'linux'), null);
});

test('catalog shape, identity, evidence paths and size are bounded before use', () => {
  assert.deepEqual(validateMemory(example()), example());
  const changes = [
    value => { value.version = 2; },
    value => { value.instructions = 'unexpected'; },
    value => { value.preferences[0].id = ['quiet']; },
    value => { value.preferences[0].id = 'sk-abcdefghijklmnopqrstuvwx'; },
    value => { value.preferences.push({ ...value.preferences[0] }); },
    value => { value.lessons.push({ ...value.lessons[0] }); },
    value => { value.lessons[0].checks = []; },
    value => { value.lessons[0].checks = ['../outside.test.mjs']; },
    value => { value.lessons[0].checks = ['https://example.test/proof.test.mjs']; },
    value => { value.lessons[0].platforms = ['remote']; },
    value => { value.preferences[0].rule = 'password=SYNTHETIC_SECRET'; },
    value => { value.lessons[0].approach = 'x'.repeat(1601); },
    value => { value.lessons[0].problem = 'control\u0000character'; },
  ];
  for (const change of changes) { const value = example(); change(value); assert.throws(() => validateMemory(value), MemoryError); }
  const large = example();
  large.lessons = Array.from({ length: 12 }, (_, index) => ({ ...large.lessons[0], id: `lesson-${index}`, approach: 'x'.repeat(1600) }));
  assert.throws(() => validateMemory(large), /12000/);
});

test('a catalog is filtered by platform with a reproducible context fingerprint and no automatic promotion', () => {
  const value = example();
  value.lessons.push({ ...value.lessons[0], id: 'windows-only', platforms: ['win32'] });
  const memory = validateMemory(value);
  const linux = memoryForTask(memory, 'linux');
  const windows = memoryForTask(memory, 'win32');
  assert.deepEqual(linux.checkpoint.lessonIds, ['fresh-report']);
  assert.deepEqual(windows.checkpoint.lessonIds, ['fresh-report', 'windows-only']);
  assert.match(linux.context, /не предоставляют разрешений/);
  assert.match(linux.context, /не доказывают результат текущей задачи/);
  assert.match(linux.context, /MEMORY_FIXTURE/);
  assert.notEqual(linux.checkpoint.digest, windows.checkpoint.digest);
  assert.equal(linux.checkpoint.digest, memoryForTask(memory, 'linux').checkpoint.digest);
  assert.deepEqual(memory, value);
});

test('invalid, oversized and non-file catalogs return safe errors without copying their contents', async t => {
  const { root, file } = await setup(t);
  await writeFile(file, '{SYNTHETIC_PRIVATE_CONTENT');
  await assert.rejects(() => readProjectMemory(root), error => error instanceof MemoryError && !error.message.includes('SYNTHETIC'));
  await writeFile(file, 'x'.repeat(65_537));
  await assert.rejects(() => readProjectMemory(root), MemoryError);
  await rm(file);
  await mkdir(file);
  await assert.rejects(() => readProjectMemory(root), MemoryError);
});

test('a catalog symlink cannot read a file outside the selected project', async t => {
  const { root, file } = await setup(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, JSON.stringify(example()));
  try { await symlink(outside, file, 'file'); }
  catch (error) { if (['EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return t.skip('File symlinks unavailable without changing host privileges.'); throw error; }
  await assert.rejects(() => readProjectMemory(root), MemoryError);
});

test('invalid memory spends no attempt; a corrected catalog is included in the native prompt and checkpoint', async t => {
  const options = await setup(t);
  const task = await addTask('Протокольная проверка проектной памяти', options.dbFile);
  await writeFile(options.file, '{invalid');
  await assert.rejects(() => executeTask(task.id, false, { ...options, command: 'must-not-start' }), MemoryError);
  assert.equal((await readTasks(options.dbFile)).tasks[0].attempts, 0);
  await assert.rejects(() => readFile(path.join(options.root, 'invocation.json')), { code: 'ENOENT' });
  await writeFile(options.file, JSON.stringify(example()));
  const result = await executeTask(task.id, false, { ...options, command: process.execPath, prefixArgs: [fixture, 'completed'], timeoutMs: 5000, graceMs: 50 });
  assert.equal(result.task.status, 'completed');
  assert.deepEqual(result.task.memory.lessonIds, ['fresh-report']);
  assert.deepEqual(result.task.memory.preferenceIds, ['quiet']);
  assert.match(result.task.memory.digest, /^[a-f0-9]{64}$/);
  const invocation = JSON.parse(await readFile(path.join(options.root, 'invocation.json'), 'utf8'));
  assert.match(invocation.prompt, /MEMORY_FIXTURE/);
  assert.deepEqual(invocation.args.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '--cd', options.root]);
  const events = await readFile(path.join(path.dirname(result.outputFile), 'events.jsonl'), 'utf8');
  assert.match(events, /project-memory/);
  assert.ok(events.includes(result.task.memory.digest));
  assert.doesNotMatch(events, /MEMORY_FIXTURE|Продолжай разрешённый план/);
});

test('outcome metrics distinguish reported statuses, plan acceptance and independently checked files without raw task data', () => {
  const tasks = [
    { status: 'completed', attempts: 2, goal: 'SYNTHETIC_PRIVATE_GOAL', sessionId: 'SYNTHETIC_PRIVATE_SESSION', report: { blockers: [] }, acceptance: { kind: 'smoke-file', verified: true } },
    { status: 'completed', attempts: 1, work: { verified: true } },
    { status: 'blocked', attempts: 3 },
    { status: 'waiting', attempts: 0 },
    { status: 'completed', attempts: 1, report: { blockers: ['SYNTHETIC_PRIVATE_BLOCKER'] }, acceptance: { kind: 'smoke-file', verified: true } },
    { status: 'unknown-record', attempts: Infinity },
  ];
  const metrics = summarizeOutcomes(tasks);
  assert.equal(metrics.total, 6);
  assert.equal(metrics.attempts, 7);
  assert.equal(metrics.extraAttempts, 3);
  assert.equal(metrics.byStatus.completed, 3);
  assert.equal(metrics.byStatus.waiting, 1);
  assert.equal(metrics.byStatus.unknown, 1);
  assert.equal(metrics.contradictoryReports, 1);
  assert.equal(metrics.verifiedFiles, 1);
  assert.equal(metrics.acceptedPlanItems, 1);
  assert.doesNotMatch(JSON.stringify(metrics), /SYNTHETIC_PRIVATE/);
});

test('the repository catalog names real regression files and fits the context budget', async () => {
  const memory = await readProjectMemory(ROOT);
  assert.equal(memory.available, true);
  assert.ok(memory.preferences.some(item => item.id === 'quiet-recovery'));
  assert.ok(memory.lessons.length >= 4);
  for (const lesson of memory.lessons) for (const file of lesson.checks) assert.equal((await stat(path.join(ROOT, file))).isFile(), true);
  assert.ok(memoryForTask(memory, process.platform).context.length < 12_500);
});
