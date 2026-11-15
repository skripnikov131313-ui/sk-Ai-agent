import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../src/store.mjs';
import { replaceFile } from '../src/atomic-file.mjs';

async function files(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'new.tmp');
  const destination = path.join(root, 'tasks.json');
  await writeFile(source, 'new checkpoint');
  await writeFile(destination, 'old checkpoint');
  return { source, destination };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`replacement survives transient Windows ${code} without removing the existing database`, async t => {
    const { source, destination } = await files(t);
    let attempts = 0;
    await replaceFile(source, destination, { platform: 'win32', retryDelayMs: 0,
      renameFile: async (...args) => {
        if (++attempts < 3) {
          assert.equal(await readFile(destination, 'utf8'), 'old checkpoint');
          throw Object.assign(new Error('synthetic sharing violation'), { code });
        }
        return rename(...args);
      },
    });
    assert.equal(attempts, 3);
    assert.equal(await readFile(destination, 'utf8'), 'new checkpoint');
    await assert.rejects(() => readFile(source), { code: 'ENOENT' });
  });
}

test('persistent replacement failure is bounded and preserves both the old file and original error', async t => {
  const { source, destination } = await files(t);
  const failure = Object.assign(new Error('synthetic persistent permission failure'), { code: 'EPERM' });
  let attempts = 0;
  await assert.rejects(() => replaceFile(source, destination, { platform: 'win32', maxAttempts: 3, retryDelayMs: 0,
    renameFile: async () => { attempts++; throw failure; },
  }), error => error === failure);
  assert.equal(attempts, 3);
  assert.equal(await readFile(destination, 'utf8'), 'old checkpoint');
  assert.equal(await readFile(source, 'utf8'), 'new checkpoint');
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']]) {
  test(`replacement reports ${platform} ${code} immediately`, async () => {
    const failure = Object.assign(new Error('synthetic failure'), { code });
    let attempts = 0;
    await assert.rejects(() => replaceFile('unused', 'unused', { platform,
      renameFile: async () => { attempts++; throw failure; },
    }), error => error === failure);
    assert.equal(attempts, 1);
  });
}
