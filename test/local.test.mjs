import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readTasks } from '../src/store.mjs';
import { localSession } from '../src/local.mjs';

const client = fileURLToPath(new URL('./fixtures/local-client.mjs', import.meta.url));
async function fixture(t, mode) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'local-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'LOCAL_HANDOFF.md'), 'test context');
  return { root, command: process.execPath, prefixArgs: [client, mode], timeoutMs: 5000, handleSignals: false };
}

test('local launch inherits the terminal and passes project, sandbox, and handoff context', async t => {
  const options = await fixture(t, 'success');
  const result = await localSession(options);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const invocation = JSON.parse(await readFile(path.join(options.root, 'local-invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, options.root);
  assert.deepEqual(invocation.args.slice(0, 4), ['--sandbox', 'workspace-write', '--cd', options.root]);
  assert.match(invocation.args.at(-1), /docs\/LOCAL_HANDOFF\.md/);
  assert.doesNotMatch(invocation.args.join(' '), /bypass|danger-full-access|approve-for-me/);
  assert.equal((await readTasks(path.join(options.root, '.skai-agent', 'tasks.json'))).tasks.length, 0);
});

test('local launch preserves a client failure code', async t => {
  const result = await localSession(await fixture(t, 'fail'));
  assert.equal(result.code, 7);
});

test('local launch enforces its session deadline', async t => {
  const options = await fixture(t, 'wait');
  const result = await localSession({ ...options, timeoutMs: 200 });
  assert.equal(result.reason, 'timeout');
  assert.notEqual(result.code, 0);
});
