import { access, mkdir, writeFile } from 'node:fs/promises';
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
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export async function diagnose(root, dataDir) {
  const tools = { node: process.execPath };
  for (const name of ['git', 'codex', 'gh', 'cmake', 'dotnet']) tools[name] = await findExecutable(name);
  tools.codex = await findExecutable('codex', process.env, { nativeOnly: true }) || tools.codex;
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
