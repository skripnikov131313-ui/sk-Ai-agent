import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireStoreLock } from './file-lock.mjs';
import { DATA_DIR, ROOT, isAlive, readTasks, recoverStore, writeTasks } from './store.mjs';
import { recoverTask } from './runner.mjs';

export const BACKGROUND_DIR = path.join(DATA_DIR, 'work');
const active = new Set(['starting', 'running']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const entry = fileURLToPath(new URL('./work-daemon.mjs', import.meta.url));

export async function backgroundStatus(dataDir = BACKGROUND_DIR) {
  let state;
  try { state = JSON.parse(await readFile(path.join(dataDir, 'service.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!UUID.test(state.id ?? '') || !Number.isSafeInteger(state.pid) || state.pid <= 0) {
    return { ...state, status: 'unknown', reason: 'Нет подтверждённого идентификатора и PID фонового процесса.' };
  }
  if (state.host !== os.hostname()) return { ...state, status: 'unknown', reason: 'Состояние с другой машины; наличие процесса не подтверждено.' };
  const alive = isAlive(state.pid);
  return { ...state, processAlive: alive, status: active.has(state.status) && !alive ? 'lost' : state.status };
}

export async function startBackground(options = {}) {
  const root = await realpath(options.root ?? ROOT);
  const dataDir = path.resolve(options.dataDir ?? BACKGROUND_DIR);
  const relative = path.relative(root, dataDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Фоновое состояние должно находиться внутри проекта.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dataDir, 'service.json');
  const lockFile = `${stateFile}.lock`;
  const lock = await acquireStoreLock(lockFile, { maxAttempts: 1 });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const previous = await backgroundStatus(dataDir);
    if (previous && (active.has(previous.status) || ['unknown', 'lost'].includes(previous.status))) {
      throw new Error('Фоновый процесс уже работает либо его остановка не подтверждена. Проверьте work-status; после аварии используйте work-recover.');
    }
    const id = randomUUID();
    const directory = path.join(dataDir, 'services', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const configFile = path.join(directory, 'config.json');
    const logFile = path.join(directory, 'worker.log');
    const config = { root, dataDir, dbFile: options.dbFile ?? path.join(dataDir, 'tasks.json') };
    for (const key of ['source', 'budgetMs', 'taskTimeoutMs', 'maxTasks', 'maxAttempts', 'retryBlocked', 'desktop', 'command', 'prefixArgs', 'graceMs']) {
      if (options[key] !== undefined) config[key] = options[key];
    }
    const log = await open(logFile, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [entry, configFile], { cwd: root, detached: true,
        windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await log.close(); }
    // The child cannot execute work before this record publishes its known PID.
    await writeTasks({ id, pid: child.pid, host: os.hostname(), status: 'starting',
      source: config.source ?? 'TASKS.md', logFile, startedAt: new Date().toISOString() }, stateFile);
    await writeTasks({ id, pid: child.pid, stateFile, options: config }, configFile);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await backgroundStatus(dataDir);
      if (state?.id === id && state.status !== 'starting') return state;
      await delay(25);
    }
    throw new Error('Старт фонового процесса не подтверждён за 10 секунд; проверьте work-status перед повторным запуском.');
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

export async function stopBackground(dataDir = BACKGROUND_DIR) {
  const state = await backgroundStatus(dataDir);
  if (!state || (!active.has(state.status) && !['unknown', 'lost'].includes(state.status))) return state;
  if (state.status === 'unknown' || state.status === 'lost' || !UUID.test(state.id)) throw new Error('Остановка процесса не подтверждена; требуется work-recover на исходной машине.');
  // A cooperative request also works on Windows, where process.kill(SIGTERM)
  // would terminate Node immediately and could leave native children behind.
  await writeTasks({ id: state.id }, path.join(dataDir, 'services', state.id, 'stop.json'));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await backgroundStatus(dataDir);
    if (!active.has(current?.status)) return current;
    await delay(50);
  }
  throw new Error('Запрос остановки сохранён; завершение ещё не подтверждено. Проверьте work-status.');
}

export async function recoverBackground(dataDir = BACKGROUND_DIR, dbFile = path.join(dataDir, 'tasks.json')) {
  const state = await backgroundStatus(dataDir);
  if (state && (active.has(state.status) || state.status === 'unknown')) throw new Error('Нельзя восстанавливать живой или неподтверждённый фоновый процесс.');
  await recoverStore(path.join(dataDir, 'service.json'));
  await recoverStore(`${dbFile}.work`);
  await recoverStore(dbFile);
  for (const task of (await readTasks(dbFile)).tasks) {
    if (task.status === 'running') await recoverTask(task.id, dbFile);
  }
  if (state?.status === 'lost') await writeTasks({ ...state, status: 'interrupted', reason: 'Остановка старого процесса подтверждена.' }, path.join(dataDir, 'service.json'));
}
