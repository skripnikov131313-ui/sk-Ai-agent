import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { findExecutable } from './doctor.mjs';
import { runProcess } from './process.mjs';

export class PortableWorkspaceError extends Error {}

// A ZIP has no original .git or credentials. Create a local repository only
// when execution is requested, so Codex can use its ordinary Git checks.
export async function preparePortableWorkspace(root, { signal } = {}) {
  const file = path.join(root, 'BUILDINFO.json');
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new PortableWorkspaceError('Повреждены сведения переносимого пакета.');
  let build;
  try { build = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new PortableWorkspaceError('Повреждены сведения переносимого пакета.'); }
  if (!build || typeof build !== 'object' || Array.isArray(build) || build.formatVersion !== 1 || build.project !== 'Sk/Ai Agent' || build.platform !== 'win32-x64' || typeof build.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(build.sourceCommit)) {
    throw new PortableWorkspaceError('Неизвестный формат переносимого пакета.');
  }
  root = await realpath(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && key.toUpperCase() !== 'PATH'));
  env.PATH = process.env.PATH ?? '';
  if (process.platform === 'win32') env.PATHEXT = process.env.PATHEXT ?? '.EXE;.COM;.BAT;.CMD';
  const git = await findExecutable('git', env, { nativeOnly: true });
  if (!git) throw new PortableWorkspaceError('Для выполнения задач нужен установленный Git. Панель и просмотр очереди доступны без него.');
  const invoke = args => runProcess(git, ['-C', root, ...args], { cwd: root, env, signal, timeoutMs: 10_000 });
  let exists = false;
  try {
    const metadata = await lstat(path.join(root, '.git'));
    if (metadata.isSymbolicLink()) throw new PortableWorkspaceError('Git metadata переносимого проекта не должна быть ссылкой.');
    exists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    const result = await invoke(['init', '--quiet']);
    if (result.code !== 0) throw new PortableWorkspaceError('Не удалось подготовить локальный Git репозиторий пакета. Попытка Codex не запускалась.');
  }
  const top = await invoke(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || await realpath(top.stdout.trim()) !== root) throw new PortableWorkspaceError('Git репозиторий не совпадает с папкой переносимого проекта.');
  return true;
}
