import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readTasks } from '../src/store.mjs';
import { smoke } from '../src/smoke.mjs';

const executor = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
async function setup(t, mode) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'smoke-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.skai-agent');
  return { root, dataDir, dbFile: path.join(dataDir, 'tasks.json'),
    command: process.execPath, prefixArgs: [executor, mode], timeoutMs: 5000 };
}

test('smoke requires an actual fresh file matching its per-run marker', async t => {
  const options = await setup(t, 'smoke');
  const result = await smoke(options);
  assert.equal(result.verified, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.task.status, 'completed');
  const proof = result.task.acceptance;
  assert.equal(await readFile(path.join(options.root, proof.file), 'utf8'), `${proof.marker}\n`);
  const stored = (await readTasks(options.dbFile)).tasks[0];
  assert.equal(stored.acceptance.verified, true);
  assert.equal(stored.attempts, 1);
});

for (const mode of ['completed', 'smoke-wrong']) {
  test(`smoke rejects model completion with ${mode === 'completed' ? 'no proof file' : 'the wrong proof'}`, async t => {
    const options = await setup(t, mode);
    const result = await smoke(options);
    assert.equal(result.verified, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.task.status, 'failed');
    assert.equal(result.task.report.status, 'completed', 'model report is retained as separate evidence');
    assert.equal((await readTasks(options.dbFile)).tasks[0].acceptance.verified, false);
  });
}

test('blocked execution remains blocked and does not pass smoke acceptance', async t => {
  const options = await setup(t, 'smoke-blocked');
  const result = await smoke(options);
  assert.equal(result.verified, false);
  assert.equal(result.task.status, 'blocked');
  assert.equal(result.exitCode, 2);
});

test('smoke refuses proof files outside the checkout', async t => {
  const options = await setup(t, 'smoke');
  await assert.rejects(() => smoke({ ...options, dataDir: path.dirname(options.root) }), /inside the project/);
  assert.equal((await readTasks(options.dbFile)).tasks.length, 0);
});
