import { lstat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { addTask, DATA_DIR, ROOT, TASKS_FILE, updateTask } from './store.mjs';
import { executeTask } from './runner.mjs';
import { findCodex } from './doctor.mjs';

// One real executor attempt. The final model message alone cannot pass this
// acceptance check: a fresh file with the exact per-run marker must exist.
export async function smoke({ root = ROOT, dataDir = DATA_DIR, dbFile = TASKS_FILE, ...runnerOptions } = {}) {
  const command = runnerOptions.command ?? await findCodex();
  if (!command) throw new Error('Codex CLI не найден. Выполните doctor или укажите SKAI_CODEX_EXE.');
  const marker = `SKAI-SMOKE-${randomUUID()}`;
  const relativeFile = path.relative(root, path.join(dataDir, `smoke-${randomUUID()}.txt`)).split(path.sep).join('/');
  if (relativeFile.startsWith('../') || path.isAbsolute(relativeFile)) throw new Error('Smoke file must remain inside the project.');
  const goal = `Проверка локального executor. Создай файл ${relativeFile} в корне проекта в UTF-8 без BOM. Его содержимое — одна строка ${marker} и перевод строки LF или CRLF. Затем прочитай файл и проверь точное совпадение. Не меняй другие файлы, не устанавливай ПО, не выполняй HTTP-запросы из инструментов, не публикуй изменения. Если выполнить файловую операцию невозможно, верни blocked с причиной.\nSMOKE_FILE=${relativeFile}\nSMOKE_MARKER=${marker}`;
  const task = await addTask(goal, dbFile);
  await updateTask(task.id, { acceptance: { kind: 'smoke-file', file: relativeFile, marker, verified: false } }, dbFile);
  const result = await executeTask(task.id, false, { ...runnerOptions, root, dataDir, dbFile, command });
  if (result.task.status !== 'completed') return { ...result, verified: false };
  let verified = false;
  try {
    const file = path.join(root, relativeFile);
    const info = await lstat(file);
    if (info.isFile() && info.size <= marker.length + 2) {
      const actual = await readFile(file, 'utf8');
      verified = actual === `${marker}\n` || actual === `${marker}\r\n`;
    }
  } catch { /* An unreadable or absent proof cannot pass acceptance. */ }
  result.task = await updateTask(task.id, {
    status: verified ? 'completed' : 'failed',
    error: verified ? null : 'Smoke: модель сообщила completed, но свежий файл с ожидаемой строкой не подтверждён.',
    acceptance: { kind: 'smoke-file', file: relativeFile, marker, verified, checkedAt: new Date().toISOString() },
  }, dbFile);
  return { ...result, verified, exitCode: verified ? 0 : 1 };
}
