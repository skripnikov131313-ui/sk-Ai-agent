import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, transaction } from './store.mjs';
import { findExecutable } from './doctor.mjs';
import { runProcess } from './process.mjs';
import { safeStatus } from './privacy.mjs';

export const PROJECT_ID = /^[a-z][a-z0-9-]{0,47}$/;
export class ProjectError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function assertStatePath(root, file) {
  file = path.resolve(file);
  if (!within(root, file)) throw new ProjectError('Состояние проекта должно находиться в служебной папке Agent.');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new ProjectError('Служебный путь проекта не должен быть символической ссылкой.');
  }
}

export async function readProjectRegistry(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: [] }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new ProjectError('Некорректный реестр проектов.');
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new ProjectError('Реестр проектов повреждён. Существующие записи сохранены.'); }
  if (!data || data.version !== 1 || !Array.isArray(data.projects) || data.projects.length > 16 ||
      Object.keys(data).some(key => !['version', 'projects'].includes(key))) throw new ProjectError('Некорректный реестр проектов.');
  const ids = new Set();
  for (const project of data.projects) {
    if (!project || typeof project !== 'object' || Array.isArray(project) ||
        Object.keys(project).some(key => !['id', 'name', 'root', 'gitDirectory', 'repository'].includes(key)) ||
        typeof project.id !== 'string' || !PROJECT_ID.test(project.id) || project.id === 'agent' || ids.has(project.id) ||
        typeof project.name !== 'string' || !project.name.trim() || project.name.length > 80 || /[\x00-\x1f]/.test(project.name) || safeStatus(project.name) !== project.name ||
        typeof project.root !== 'string' || !path.isAbsolute(project.root) || project.root.length > 2048 ||
        typeof project.gitDirectory !== 'string' || !path.isAbsolute(project.gitDirectory) || project.gitDirectory.length > 2048 ||
        !(project.repository === null || (typeof project.repository === 'string' && /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(project.repository)))) {
      throw new ProjectError('Некорректная запись проекта.');
    }
    ids.add(project.id);
  }
  return data;
}

function repositoryName(value) {
  if (!value) return null;
  let url;
  try {
    const scp = /^(?:[^@/:]+@)?github\.com:([^\s]+)$/i.exec(value);
    url = new URL(scp ? `https://github.com/${scp[1]}` : value);
  } catch { throw new ProjectError('Origin проекта должен указывать на GitHub либо отсутствовать.'); }
  const name = url.pathname.replace(/^\//, '').replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
  if (!['https:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) {
    throw new ProjectError('Origin проекта должен указывать на GitHub либо отсутствовать.');
  }
  // Never persist userinfo, tokens, query strings, or the original URL.
  return `github.com/${name}`;
}

export async function inspectProject(root, { signal } = {}) {
  let canonical;
  try { canonical = await realpath(root); }
  catch { throw new ProjectError('Рабочая папка проекта недоступна. История Agent сохранена.'); }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && key.toUpperCase() !== 'PATH'));
  env.PATH = process.env.PATH ?? '';
  if (process.platform === 'win32') env.PATHEXT = process.env.PATHEXT ?? '.EXE;.COM;.BAT;.CMD';
  const git = await findExecutable('git', env, { nativeOnly: true });
  if (!git) throw new ProjectError('Для проверки зарегистрированного проекта нужен Git.');
  const invoke = args => runProcess(git, ['-C', canonical, ...args], { cwd: canonical, env, signal, timeoutMs: 10_000 });
  const top = await invoke(['rev-parse', '--show-toplevel']);
  let topRoot;
  try { if (top.code === 0) topRoot = await realpath(top.stdout.trim()); } catch { /* Static error below. */ }
  if (topRoot !== canonical) throw new ProjectError('Выберите корень отдельного Git репозитория.');
  const directory = await invoke(['rev-parse', '--absolute-git-dir']);
  if (directory.code !== 0) throw new ProjectError('Не удалось проверить Git metadata проекта.');
  let gitDirectory;
  try { gitDirectory = await realpath(directory.stdout.trim()); }
  catch { throw new ProjectError('Git metadata проекта недоступна.'); }
  const origin = await invoke(['config', '--get', 'remote.origin.url']);
  if (![0, 1].includes(origin.code)) throw new ProjectError('Не удалось проверить origin проекта.');
  return { root: canonical, gitDirectory, repository: repositoryName(origin.code === 0 ? origin.stdout.trim() : null) };
}

function projectContext(record, appRoot, appDataDir) {
  const dataDir = path.join(appDataDir, 'projects', record.id);
  const scope = createHash('sha256').update(JSON.stringify({ id: record.id, root: record.root,
    gitDirectory: record.gitDirectory, repository: record.repository, dataDir })).digest('hex');
  return { ...record, appRoot, appDataDir, dataDir, dbFile: path.join(dataDir, 'tasks.json'),
    workDbFile: path.join(dataDir, 'work', 'tasks.json'), scope };
}

export async function loadProjectCatalog({ root = ROOT, dataDir = path.join(root, '.skai-agent'),
  dbFile = path.join(dataDir, 'tasks.json'), workDbFile = path.join(dataDir, 'work', 'tasks.json') } = {}) {
  root = await realpath(root);
  dataDir = path.resolve(dataDir);
  await assertStatePath(root, dataDir);
  const registryFile = path.join(dataDir, 'projects.json');
  const registry = await readProjectRegistry(registryFile);
  const scope = createHash('sha256').update(JSON.stringify({ id: 'agent', root, dataDir, dbFile, workDbFile })).digest('hex');
  const catalog = [{ id: 'agent', name: path.basename(root), root, dataDir, dbFile, workDbFile, scope, repository: null, context: null }];
  for (const record of registry.projects) {
    if (catalog.some(project => within(project.root, record.root) || within(record.root, project.root))) throw new ProjectError('Рабочие папки проектов не должны пересекаться.');
    const context = projectContext(record, root, dataDir);
    catalog.push({ ...context, context });
  }
  return catalog;
}

export async function registerProject({ id, name, root, appRoot = ROOT, appDataDir = path.join(appRoot, '.skai-agent') }) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || id === 'agent' || typeof name !== 'string' || !name.trim() || name.length > 80 ||
      /[\x00-\x1f]/.test(name) || safeStatus(name) !== name) throw new ProjectError('Нужны ID проекта и название до 80 символов.', 400);
  appRoot = await realpath(appRoot);
  appDataDir = path.resolve(appDataDir);
  await assertStatePath(appRoot, appDataDir);
  const inspected = await inspectProject(root);
  if (within(appRoot, inspected.root) || within(inspected.root, appRoot)) throw new ProjectError('Дополнительный проект должен иметь отдельную рабочую папку.');
  const record = { id, name: name.trim(), ...inspected };
  const file = path.join(appDataDir, 'projects.json');
  return transaction(file, db => {
    const previous = db.projects.find(project => project.id === id);
    if (previous) {
      if (previous.root !== record.root || previous.gitDirectory !== record.gitDirectory || previous.repository !== record.repository) throw new ProjectError('ID проекта уже связан с другой рабочей папкой или репозиторием.');
      previous.name = record.name;
      return previous;
    }
    if (db.projects.length >= 16 || db.projects.some(project => within(project.root, record.root) || within(record.root, project.root))) throw new ProjectError('Проекты пересекаются или достигнут предел 16 проектов.');
    db.projects.push(record);
    return record;
  }, readProjectRegistry);
}

export async function assertProjectContext(project, { root, dataDir, dbFile, signal, workspace = true } = {}) {
  if (!project || project.id === 'agent') throw new ProjectError('Нужен зарегистрированный проект.');
  const catalog = await loadProjectCatalog({ root: project.appRoot, dataDir: project.appDataDir });
  const current = catalog.find(item => item.id === project.id)?.context;
  if (!current || current.scope !== project.scope || (root && root !== current.root) ||
      (dataDir && dataDir !== current.dataDir) || (dbFile && dbFile !== current.dbFile)) throw new ProjectError('Привязка проекта изменилась. Обновите панель перед выполнением.');
  await assertStatePath(current.appRoot, current.dataDir);
  await assertStatePath(current.appRoot, current.dbFile);
  await assertStatePath(current.appRoot, current.workDbFile);
  if (workspace) {
    const actual = await inspectProject(current.root, { signal });
    if (actual.root !== current.root || actual.gitDirectory !== current.gitDirectory || actual.repository !== current.repository) throw new ProjectError('Рабочая папка или origin проекта изменились. Выполнение остановлено до проверки привязки.');
  }
  return current;
}

export function bindProjectStore(db, project, { bind = true } = {}) {
  const expected = project ? { id: project.id, scope: project.scope } : null;
  if (db.projectBinding && (!expected || db.projectBinding.id !== expected.id || db.projectBinding.scope !== expected.scope)) throw new ProjectError('Эта очередь принадлежит другому проекту. Данные сохранены.');
  if (expected && !db.projectBinding && (db.tasks.length || db.batch || db.controller)) throw new ProjectError('У существующей очереди нет подтверждённой привязки к этому проекту. Данные сохранены.');
  if (expected && !db.projectBinding && bind) db.projectBinding = expected;
}
