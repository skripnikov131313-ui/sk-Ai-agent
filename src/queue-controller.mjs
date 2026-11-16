import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireStoreLock } from './file-lock.mjs';
import { DATA_DIR, ROOT, TASKS_FILE, isAlive, readTasks, recoverStore, transaction } from './store.mjs';
import { executeTask, MAX_ATTEMPTS, recoverTask } from './runner.mjs';
import { safeStatus } from './privacy.mjs';
import { createWorkerProfile, evaluateTaskRoute, reconcileWaitingTasks } from './routing.mjs';
import { assertProjectContext, bindProjectStore } from './projects.mjs';

export class QueueError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

export function createQueueController({ root = ROOT, dataDir = DATA_DIR, dbFile = TASKS_FILE,
  command, prefixArgs = [], timeoutMs = 600_000, graceMs = 500,
  desktop = false, worker = createWorkerProfile({ desktop }), project = null } = {}) {
  worker = createWorkerProfile(worker);
  let busy = false;
  let current = null;
  let cancellation = null;
  let lastError = null;
  const lockFile = `${dbFile}.batch.lock`;

  async function start(resumeId = null) {
    if (busy || current) throw new QueueError('Очередь уже выполняется.');
    busy = true;
    cancellation = new AbortController();
    let lock;
    let transferred = false;
    try {
      if (project) await assertProjectContext(project, { root, dataDir, dbFile, signal: cancellation.signal });
      await mkdir(path.dirname(dbFile), { recursive: true, mode: 0o700 });
      try { lock = await acquireStoreLock(lockFile, { maxAttempts: 1 }); }
      catch { throw new QueueError('Очередь занята другим исполнителем или требует восстановления после сбоя.'); }
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
      const batch = await transaction(dbFile, db => {
        bindProjectStore(db, project);
        if (db.tasks.some(task => task.status === 'running')) throw new QueueError('Есть выполняющаяся задача. Подтвердите её остановку перед восстановлением.');
        reconcileWaitingTasks(db, worker);
        let tasks;
        if (resumeId) {
          const task = db.tasks.find(task => task.id === resumeId);
          if (!task) throw new QueueError('Задача не найдена.', 404);
          if (!['failed', 'blocked', 'interrupted'].includes(task.status) || !task.sessionId || task.attempts >= MAX_ATTEMPTS) {
            throw new QueueError('Нет сохранённой сессии для продолжения или достигнут предел попыток.');
          }
          const route = evaluateTaskRoute(task, db.tasks, worker);
          if (!route.eligible) throw new QueueError(route.message);
          tasks = [task];
        } else tasks = db.tasks.filter(task => ['queued', 'waiting'].includes(task.status));
        if (!tasks.length) throw new QueueError('В очереди нет ожидающих задач.');
        db.batch = { id: randomUUID(), status: 'running', taskIds: tasks.map(task => task.id),
          workerPid: process.pid, workerHost: os.hostname(), completed: 0, waiting: 0, activeTaskId: null,
          startedAt: new Date().toISOString(), finishedAt: null, error: null };
        return { ...db.batch };
      });
      lastError = null;
      const controller = cancellation;
      const checkpoint = patch => transaction(dbFile, db => {
        bindProjectStore(db, project, { bind: false });
        if (db.batch?.id !== batch.id) throw new QueueError('Изменился владелец запуска очереди.');
        Object.assign(db.batch, patch);
      });
      const finish = (status, error = null, waiting = 0) => checkpoint({ status, waiting, error: error ? safeStatus(error) : null,
        activeTaskId: null, finishedAt: new Date().toISOString() });
      async function run() {
        let completed = 0;
        try {
          // Freeze the user's queue at launch: later submissions wait for the
          // next explicit launch and cannot prolong this batch indefinitely.
          const pending = new Set(batch.taskIds);
          while (pending.size) {
            if (controller.signal.aborted) return await finish('interrupted', 'Очередь остановлена пользователем.');
            const next = await transaction(dbFile, db => {
              bindProjectStore(db, project, { bind: false });
              reconcileWaitingTasks(db, worker);
              return db.tasks.find(task => pending.has(task.id) &&
                (task.id === resumeId || ['queued', 'waiting'].includes(task.status)) &&
                evaluateTaskRoute(task, db.tasks, worker).eligible);
            });
            if (!next) return await finish('waiting', 'Оставшиеся задачи ожидают подходящую среду или завершение зависимостей.', pending.size);
            const id = next.id;
            pending.delete(id);
            let resume = id === resumeId;
            while (true) {
              if (controller.signal.aborted) return await finish('interrupted', 'Очередь остановлена пользователем.');
              await checkpoint({ activeTaskId: id });
              const result = await executeTask(id, resume, { root, dataDir, dbFile, command, prefixArgs,
                timeoutMs, graceMs, signal: controller.signal, worker, project });
              const task = result.task;
              if (task.status === 'completed') {
                completed++;
                await checkpoint({ completed });
              }
              if (controller.signal.aborted || result.exitCode === 130) return await finish('interrupted', 'Очередь остановлена пользователем.');
              if (task.status === 'completed') break;
              if (task.status === 'waiting') break;
              const retryable = task.attempts < MAX_ATTEMPTS && task.sessionId &&
                ((task.status === 'interrupted' && result.exitCode === 124) ||
                 (task.status === 'failed' && task.report && task.report.blockers.length === 0));
              if (retryable) { resume = true; continue; }
              return await finish(task.status, task.error || task.report?.blockers[0] || 'Исполнитель не завершил задачу.');
            }
          }
          const deferred = await transaction(dbFile, db => {
            bindProjectStore(db, project, { bind: false });
            reconcileWaitingTasks(db, worker);
            return db.tasks.filter(task => batch.taskIds.includes(task.id) && task.status !== 'completed').length;
          });
          await finish(deferred ? 'waiting' : 'completed', deferred ? 'Часть задач ожидает подходящие условия.' : null, deferred);
        } catch (error) {
          if (controller.signal.aborted) {
            try { await finish('interrupted', 'Очередь остановлена пользователем.'); } catch { /* Preserve state if storage is unavailable. */ }
            return;
          }
          lastError = safeStatus(error.message);
          try { await finish('failed', lastError); } catch { /* Preserve a damaged database for recovery. */ }
        } finally {
          try { await lock.close(); await rm(lockFile, { force: true }); }
          catch (error) { lastError = safeStatus(error.message); }
          current = null;
          cancellation = null;
        }
      }
      current = run();
      transferred = true;
      return batch;
    } finally {
      busy = false;
      if (lock && !transferred) { await lock.close(); await rm(lockFile, { force: true }); }
      if (!transferred) cancellation = null;
    }
  }

  function requestStop() { cancellation?.abort(); }
  async function stop() { requestStop(); if (current) await current; }
  async function recover() {
    if (busy || current) throw new QueueError('Сначала остановите текущий запуск.');
    busy = true;
    try {
      if (project) await assertProjectContext(project, { dbFile, workspace: false });
      await recoverStore(dbFile);
      const stored = await readTasks(dbFile);
      bindProjectStore(stored, project, { bind: false });
      for (const task of stored.tasks) if (task.status === 'running') await recoverTask(task.id, dbFile, project);
      await recoverStore(`${dbFile}.batch`);
      await transaction(dbFile, db => {
        bindProjectStore(db, project, { bind: false });
        if (!['running', 'stopping'].includes(db.batch?.status)) return;
        if (db.batch.workerHost !== os.hostname() || !Number.isSafeInteger(db.batch.workerPid) ||
            db.batch.workerPid <= 0 || isAlive(db.batch.workerPid)) throw new QueueError('Остановка прежнего исполнителя не подтверждена.');
        Object.assign(db.batch, { status: 'interrupted', activeTaskId: null,
          finishedAt: new Date().toISOString(), error: 'Очередь восстановлена после остановки прежнего исполнителя.' });
      });
      lastError = null;
    } catch (error) {
      if (/^Нельзя подтвердить остановку/.test(error.message)) throw new QueueError('Остановка прежнего исполнителя не подтверждена. Живой процесс, неизвестный PID или другая машина требуют отдельной проверки.');
      throw error;
    } finally { busy = false; }
  }
  return { start, requestStop, stop, recover, get active() { return busy || Boolean(current); },
    get error() { return lastError; } };
}
