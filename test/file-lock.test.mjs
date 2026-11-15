import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { DATA_DIR } from '../src/store.mjs';
import { acquireStoreLock } from '../src/file-lock.mjs';

async function fixture(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'file-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'tasks.json.lock');
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`exclusive lock survives transient Windows ${code}`, async t => {
    const file = await fixture(t);
    let calls = 0;
    const lock = await acquireStoreLock(file, {
      platform: 'win32', maxAttempts: 4, retryDelayMs: 1,
      openFile: async (...args) => {
        if (++calls <= 2) throw Object.assign(new Error('temporary sharing failure'), { code });
        return open(...args);
      },
    });
    try {
      await lock.writeFile('owned by this transaction');
      assert.equal(await readFile(file, 'utf8'), 'owned by this transaction');
      assert.equal(calls, 3);
    } finally { await lock.close(); }
  });
}

test('persistent Windows permission failure is bounded and preserves the original error', async t => {
  const file = await fixture(t);
  await writeFile(file, 'existing owner');
  const failure = Object.assign(new Error('persistent access denial'), { code: 'EPERM', syscall: 'open' });
  let calls = 0;
  await assert.rejects(() => acquireStoreLock(file, {
    platform: 'win32', maxAttempts: 3, retryDelayMs: 1,
    openFile: async () => { calls++; throw failure; },
  }), error => error === failure);
  assert.equal(calls, 3);
  assert.equal(await readFile(file, 'utf8'), 'existing owner');
});

test('non-Windows permission failures are reported immediately', async t => {
  const file = await fixture(t);
  const failure = Object.assign(new Error('access denial'), { code: 'EPERM' });
  let calls = 0;
  await assert.rejects(() => acquireStoreLock(file, {
    platform: 'linux', openFile: async () => { calls++; throw failure; },
  }), error => error === failure);
  assert.equal(calls, 1);
});

test('contention never steals an existing lock', async t => {
  const file = await fixture(t);
  await writeFile(file, 'existing owner');
  const exists = Object.assign(new Error('already owned'), { code: 'EEXIST' });
  await assert.rejects(() => acquireStoreLock(file, {
    maxAttempts: 3, retryDelayMs: 1, openFile: async () => { throw exists; },
  }), error => /Очередь занята/.test(error.message) && error.cause === exists);
  assert.equal(await readFile(file, 'utf8'), 'existing owner');
});

test('exclusive creation succeeds after another owner releases its file', async t => {
  const file = await fixture(t);
  await writeFile(file, 'existing owner');
  const results = await Promise.allSettled([
    delay(20).then(() => rm(file)),
    acquireStoreLock(file, { maxAttempts: 100, retryDelayMs: 5 }),
  ]);
  const lock = results[1].status === 'fulfilled' ? results[1].value : null;
  try {
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.stack);
    await lock.writeFile('new owner');
    assert.equal(await readFile(file, 'utf8'), 'new owner');
  } finally { await lock?.close(); }
});

test('unrelated filesystem failures are not retried', async t => {
  const file = await fixture(t);
  const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
  let calls = 0;
  await assert.rejects(() => acquireStoreLock(file, {
    platform: 'win32', openFile: async () => { calls++; throw failure; },
  }), error => error === failure);
  assert.equal(calls, 1);
});
