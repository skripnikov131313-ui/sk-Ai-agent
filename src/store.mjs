import { mkdir, readFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { acquireStoreLock } from './file-lock.mjs';
import { replaceFile } from './atomic-file.mjs';
import { createWorkerProfile, reconcileWaitingTasks, taskRequirements, validateDependencies } from './routing.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../');
export const DATA_DIR = path.join(ROOT, '.skai-agent');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function transaction(file, change, read = readTasks) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  const lock = await acquireStoreLock(lockFile);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const db = await read(file);
    const result = change(db);
    await writeTasks(db, file);
    return result;
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

// Explicit operation for an idle worker, never an automatic competing lock steal.
export async function recoverStore(file = TASKS_FILE) {
  const lockFile = `${file}.lock`;
  let owner;
  try { owner = JSON.parse(await readFile(lockFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || isAlive(owner.pid)) {
    throw new Error('Нельзя подтвердить остановку владельца блокировки; очередь не изменена.');
  }
  await rm(lockFile);
  return true;
}

export async function readTasks(file = TASKS_FILE) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error('invalid task database');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, tasks: [] };
    throw error;
  }
}

export async function writeTasks(db, file = TASKS_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(db, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await replaceFile(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function newTask(goal, requirements = {}) {
  const normalized = String(goal ?? '').trim();
  if (normalized.length < 5 || normalized.length > 4000) {
    throw new Error('Задача должна содержать от 5 до 4000 символов.');
  }
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), goal: normalized, ...taskRequirements(requirements), status: 'queued', createdAt: now,
    updatedAt: now, attempts: 0, sessionId: null, lastExitCode: null,
  };
  return task;
}

export async function addTask(goal, dbFile = TASKS_FILE, requirements = {}, worker = createWorkerProfile()) {
  const task = newTask(goal, requirements);
  return transaction(dbFile, db => {
    validateDependencies(task, db.tasks);
    db.tasks.push(task);
    reconcileWaitingTasks(db, worker);
    return task;
  });
}

export async function updateTask(id, patch, dbFile = TASKS_FILE, check = () => {}) {
  return transaction(dbFile, db => {
    const task = db.tasks.find(item => item.id === id);
    if (!task) throw new Error(`Задача не найдена: ${id}`);
    check(task, db);
    Object.assign(task, typeof patch === 'function' ? patch(task) : patch, { updatedAt: new Date().toISOString() });
    return task;
  });
}
