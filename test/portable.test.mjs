import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, addTask, readTasks } from '../src/store.mjs';
import { findExecutable } from '../src/doctor.mjs';
import { runProcess } from '../src/process.mjs';
import { executeTask } from '../src/runner.mjs';
import { PortableWorkspaceError, preparePortableWorkspace } from '../src/portable.mjs';

const metadata = { formatVersion: 1, project: 'Sk/Ai Agent', platform: 'win32-x64', sourceCommit: 'a'.repeat(40) };
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
async function setup(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(path.join(parent, 'portable-')));
  const root = path.join(directory, 'package with spaces & tools');
  await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { root, directory, git: await findExecutable('git', process.env, { nativeOnly: true }) };
}
async function mark(root) {
  await writeFile(path.join(root, 'BUILDINFO.json'), JSON.stringify(metadata));
  await writeFile(path.join(root, '.gitignore'), '.skai-agent/\n/runtime/\n');
}

test('ordinary checkouts are not changed by the portable bootstrap', async t => {
  const { root } = await setup(t);
  assert.equal(await preparePortableWorkspace(root), false);
  await assert.rejects(() => readFile(path.join(root, '.git', 'HEAD')), { code: 'ENOENT' });
});

test('a package creates its own Git root even inside another checkout and preserves it on restart', async t => {
  const { root, directory, git } = await setup(t);
  assert.equal((await runProcess(git, ['init', '--quiet', directory], { timeoutMs: 5000 })).code, 0);
  await mark(root);
  await mkdir(path.join(root, '.skai-agent'));
  await writeFile(path.join(root, '.skai-agent', 'tasks.json'), 'PRIVATE_LOCAL_STATE');
  assert.equal(await preparePortableWorkspace(root), true);
  const top = await runProcess(git, ['-C', root, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  assert.equal(await realpath(top.stdout.trim()), await realpath(root));
  const config = await readFile(path.join(root, '.git', 'config'), 'utf8');
  await preparePortableWorkspace(root);
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), config);
  assert.doesNotMatch(config, /\[remote/);
  assert.equal(await readFile(path.join(root, '.skai-agent', 'tasks.json'), 'utf8'), 'PRIVATE_LOCAL_STATE');
  const ignored = await runProcess(git, ['-C', root, 'check-ignore', 'runtime/node.exe', '.skai-agent/tasks.json'], { timeoutMs: 5000 });
  assert.equal(ignored.code, 0);
  assert.match(ignored.stdout, /runtime\/node.exe/);
  assert.match(ignored.stdout, /tasks.json/);
});

test('ambient Git directory variables cannot redirect bootstrap outside the package', async t => {
  const { root, directory } = await setup(t);
  await mark(root);
  const previous = process.env.GIT_DIR;
  const outside = path.join(directory, 'outside.git');
  process.env.GIT_DIR = outside;
  try {
    await preparePortableWorkspace(root);
    assert.equal(process.env.GIT_DIR, outside);
    await assert.rejects(() => readFile(path.join(outside, 'HEAD')), { code: 'ENOENT' });
    assert.match(await readFile(path.join(root, '.git', 'HEAD'), 'utf8'), /^ref:/);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
  }
});

test('missing Git is reported before execution and does not install or create a repository', async t => {
  const { root } = await setup(t);
  await mark(root);
  const previous = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(() => preparePortableWorkspace(root), PortableWorkspaceError);
    await assert.rejects(() => readFile(path.join(root, '.git', 'HEAD')), { code: 'ENOENT' });
  } finally { process.env.PATH = previous; }
});

test('invalid package metadata spends no attempt; a repaired package uses the ordinary sandbox', async t => {
  const { root } = await setup(t);
  const dataDir = path.join(root, '.skai-agent');
  const dbFile = path.join(dataDir, 'tasks.json');
  const task = await addTask('Проверить протокол переносимого пакета', dbFile);
  await writeFile(path.join(root, 'BUILDINFO.json'), '{invalid');
  await assert.rejects(() => executeTask(task.id, false, { root, dataDir, dbFile, command: 'must-not-start' }), PortableWorkspaceError);
  assert.equal((await readTasks(dbFile)).tasks[0].attempts, 0);
  await mark(root);
  const result = await executeTask(task.id, false, { root, dataDir, dbFile, command: process.execPath, prefixArgs: [fixture, 'completed'], timeoutMs: 5000 });
  assert.equal(result.task.status, 'completed');
  const invocation = JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8'));
  assert.deepEqual(invocation.args.slice(0, 5), ['exec', '--sandbox', 'workspace-write', '--cd', root]);
  assert.ok(!invocation.args.includes('--skip-git-repo-check'));
});
