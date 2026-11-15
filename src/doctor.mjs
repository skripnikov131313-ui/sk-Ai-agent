import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './process.mjs';

export async function findExecutable(name, env = process.env, { nativeOnly = false } = {}) {
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.COM;.CMD;.BAT').split(';').filter(ext => !nativeOnly || /^\.(exe|com)$/i.test(ext)) : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name + extension.toLowerCase());
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

// The WinGet portable alias can be missing while the registered package works.
// Read only known package directories; do not modify installation files or PATH.
export async function findWinGetCodex(env = process.env, arch = process.arch) {
  const user = env.LOCALAPPDATA;
  const machine = env.ProgramFiles;
  const linkDirectories = [user && path.join(user, 'Microsoft', 'WinGet', 'Links'),
    machine && path.join(machine, 'WinGet', 'Links')].filter(Boolean);
  for (const directory of linkDirectories) {
    const candidate = path.join(directory, 'codex.exe');
    if (await isFile(candidate)) return candidate;
  }
  const target = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  const names = ['codex.exe', ...(target ? [`codex-${target}-pc-windows-msvc.exe`] : [])];
  const roots = [user && path.join(user, 'Microsoft', 'WinGet', 'Packages'),
    machine && path.join(machine, 'WinGet', 'Packages')].filter(Boolean);
  const candidates = [];
  for (const root of new Set(roots)) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!/^OpenAI\.Codex_/i.test(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      for (const name of names) {
        const candidate = path.join(root, entry.name, name);
        if (await isFile(candidate)) { candidates.push(candidate); break; }
      }
    }
  }
  if (candidates.length > 1) throw new Error('Найдено несколько пакетов Codex. Укажите нужный executable через SKAI_CODEX_EXE.');
  return candidates[0] ?? null;
}

export async function findCodex(env = process.env) {
  if (env.SKAI_CODEX_EXE) {
    const candidate = path.resolve(env.SKAI_CODEX_EXE);
    const nativeName = process.platform === 'win32' ? /\.(exe|com)$/i.test(candidate) : !/\.(cmd|bat|ps1|js)$/i.test(candidate);
    if (!nativeName || !await isFile(candidate)) throw new Error('SKAI_CODEX_EXE должен указывать на существующий native executable.');
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return candidate;
  }
  const fromPath = await findExecutable('codex', env, { nativeOnly: true });
  if (fromPath) return fromPath;
  return process.platform === 'win32' ? findWinGetCodex(env) : null;
}

export async function diagnose(root, dataDir) {
  const tools = { node: process.execPath };
  for (const name of ['git', 'codex', 'gh', 'cmake', 'dotnet']) tools[name] = await findExecutable(name);
  tools.codex = await findCodex() || tools.codex;
  // Batch launchers cannot safely be passed to spawn without a shell. Report
  // their presence, but do not mistake that for a verified native executable.
  const nativeCodex = tools.codex && !/\.(cmd|bat)$/i.test(tools.codex);
  const login = nativeCodex
    ? await runProcess(tools.codex, ['login', 'status'], { cwd: root, timeoutMs: 10_000 })
    : { code: 127 };
  const result = {
    checkedAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    memoryTotalGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    memoryFreeGiB: +(os.freemem() / 1024 ** 3).toFixed(1),
    tools, codexAuthentication: login.code === 0 ? 'available' : 'not confirmed',
    codexLaunch: nativeCodex ? 'native' : tools.codex ? 'batch launcher requires native Codex path' : 'not found',
  };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dataDir, 'doctor.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}
