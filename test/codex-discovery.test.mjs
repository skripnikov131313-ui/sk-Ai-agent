import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../src/store.mjs';
import { findCodex, findWinGetCodex } from '../src/doctor.mjs';

async function fixture(t) {
  const parent = path.join(DATA_DIR, 'test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'codex-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: '', LOCALAPPDATA: path.join(root, 'Local AppData'), ProgramFiles: path.join(root, 'Program Files') };
  const put = async file => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'test fixture, never executed'); return file; };
  return { root, env, put };
}

test('WinGet native alias is usable without a PATH entry', async t => {
  const { env, put } = await fixture(t);
  const expected = await put(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codex.exe'));
  assert.equal(await findWinGetCodex(env, 'x64'), expected);
});

test('registered WinGet x64 package is found without either portable alias', async t => {
  const { env, put } = await fixture(t);
  const expected = await put(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages',
    'OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe', 'codex-x86_64-pc-windows-msvc.exe'));
  assert.equal(await findWinGetCodex(env, 'x64'), expected);
});

test('machine scope and ARM64 package executable are supported', async t => {
  const { env, put } = await fixture(t);
  const expected = await put(path.join(env.ProgramFiles, 'WinGet', 'Packages',
    'OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe', 'codex-aarch64-pc-windows-msvc.exe'));
  assert.equal(await findWinGetCodex(env, 'arm64'), expected);
});

test('sandbox helpers, other packages, and directory names are not treated as Codex', async t => {
  const { env, put } = await fixture(t);
  const root = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  await put(path.join(root, 'Another.Codex_source', 'codex.exe'));
  await put(path.join(root, 'OpenAI.Codex_source', 'codex-command-runner.exe'));
  await mkdir(path.join(root, 'OpenAI.Codex_source', 'codex.exe'));
  assert.equal(await findWinGetCodex(env, 'x64'), null);
});

test('multiple unaliased installations require an explicit selection', async t => {
  const { env, put } = await fixture(t);
  const root = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  await put(path.join(root, 'OpenAI.Codex_source-one', 'codex.exe'));
  await put(path.join(root, 'OpenAI.Codex_source-two', 'codex.exe'));
  await assert.rejects(() => findWinGetCodex(env), /несколько пакетов/);
});

test('explicit native executable takes precedence over discovery', async () => {
  assert.equal(await findCodex({ PATH: '', SKAI_CODEX_EXE: process.execPath }), process.execPath);
});

test('invalid or script overrides are rejected instead of silently bypassed', async t => {
  const { root, put } = await fixture(t);
  await assert.rejects(() => findCodex({ SKAI_CODEX_EXE: path.join(root, 'missing.exe') }), /SKAI_CODEX_EXE/);
  const script = await put(path.join(root, 'codex.cmd'));
  await assert.rejects(() => findCodex({ SKAI_CODEX_EXE: script }), /native executable/);
});

test('an absent package returns no match', async t => {
  const { env } = await fixture(t);
  assert.equal(await findWinGetCodex(env), null);
});
