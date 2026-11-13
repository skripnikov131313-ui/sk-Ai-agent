import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '../');
export const DATA_DIR = path.join(ROOT, '.skai-agent');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export async function readTasks(file = TASKS_FILE) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(parsed.tasks)) throw new Error('invalid task database');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, tasks: [] };
    throw error;
  }
}

export async function writeTasks(db, file = TASKS_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(db, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

export async function addTask(goal, dbFile = TASKS_FILE) {
  const normalized = String(goal ?? '').trim();
  if (normalized.length < 5 || normalized.length > 4000) {
    throw new Error('Задача должна содержать от 5 до 4000 символов.');
  }
  const db = await readTasks(dbFile);
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), goal: normalized, status: 'queued', createdAt: now,
    updatedAt: now, attempts: 0, sessionId: null, lastExitCode: null,
  };
  db.tasks.push(task);
  await writeTasks(db, dbFile);
  return task;
}

export async function updateTask(id, patch, dbFile = TASKS_FILE) {
  const db = await readTasks(dbFile);
  const task = db.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Задача не найдена: ${id}`);
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  await writeTasks(db, dbFile);
  return task;
}
