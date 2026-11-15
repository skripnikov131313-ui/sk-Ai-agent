import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, ROOT, TASKS_FILE, isAlive, updateTask } from './store.mjs';
import { classifyResult, explainCodexFailure } from './result.mjs';
import { runProcess } from './process.mjs';
import { safeStatus } from './privacy.mjs';
import { findCodex } from './doctor.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MAX_ATTEMPTS = 3;

export function codexArgs(root, outputFile, sessionId) {
  const args = ['exec', '--sandbox', 'workspace-write', '--cd', root];
  if (sessionId) args.push('resume');
  args.push('--json', '--output-schema', path.join(ROOT, 'task-output.schema.json'), '--output-last-message', outputFile);
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

export async function recoverTask(id, dbFile = TASKS_FILE) {
  return updateTask(id, {
    status: 'interrupted', finishedAt: new Date().toISOString(),
    error: 'Предыдущий worker остановлен. Возобновление только по явной команде.',
    workerPid: null, childPid: null,
  }, dbFile, task => {
    if (task.status !== 'running') throw new Error('Восстановление требуется только для running задачи.');
    if (task.workerHost !== os.hostname() || !task.workerPid || !task.childPid ||
        isAlive(task.workerPid) || isAlive(task.childPid)) {
      throw new Error('Нельзя подтвердить остановку worker и его процесса; задача не изменена.');
    }
  });
}

export async function executeTask(id, isResume = false, {
  root = ROOT, dataDir = DATA_DIR, dbFile = TASKS_FILE,
  command, prefixArgs = [], timeoutMs = 600_000, graceMs = 500, handleSignals = false, signal,
} = {}) {
  if (!UUID.test(id || '')) throw new Error('Ожидается UUID задачи из команды list.');
  const runToken = randomUUID();
  const task = await updateTask(id, current => ({
    status: 'running', attempts: current.attempts + 1, startedAt: new Date().toISOString(),
    finishedAt: null, lastExitCode: null, error: null, report: null,
    workerPid: process.pid, workerHost: os.hostname(), childPid: null, runToken,
  }), dbFile, current => {
    if (current.status === 'running') throw new Error('Задача уже выполняется. Для остановленного worker используйте recover.');
    if (current.attempts >= MAX_ATTEMPTS) throw new Error(`Достигнут лимит ${MAX_ATTEMPTS} попыток. Создайте отдельную задачу.`);
    if (isResume) {
      if (!['interrupted', 'failed', 'blocked'].includes(current.status)) throw new Error('Возобновить можно только interrupted/failed/blocked задачу.');
      if (!UUID.test(current.sessionId || '')) throw new Error('Нет сохранённой сессии Codex; создайте новую задачу.');
    } else if (current.status !== 'queued') throw new Error('Для продолжения используйте resume; повторный run запрещён.');
  });
  // Each attempt gets a new output file so stale successes cannot be reused.
  const runDir = path.join(dataDir, 'runs', id, `attempt-${task.attempts}-${runToken}`);
  const eventFile = path.join(runDir, 'events.jsonl');
  const outputFile = path.join(runDir, 'last-message.json');
  const checkpoint = patch => updateTask(id, patch, dbFile, current => {
    if (current.runToken !== runToken || current.status !== 'running') throw new Error('Изменился владелец задачи.');
  });
  let eventCount = 0;
  const event = data => {
    eventCount++;
    if (eventCount > 2001 && data.type !== 'process-exit') return;
    if (eventCount === 2001 && data.type !== 'process-exit') data = { type: 'output-events-truncated' };
    return appendFile(eventFile, `${JSON.stringify({ ...data, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  };
  let sessionId = task.sessionId;
  let carry = '';
  let dropping = false;
  let clientFailure = null;
  const parseLine = async line => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { await event({ type: 'unparsed-output' }); return; }
    if (parsed?.type === 'thread.started' && UUID.test(parsed.thread_id || '')) {
      sessionId = parsed.thread_id;
      await checkpoint({ sessionId });
      await event({ type: 'thread.started' });
    } else if (parsed?.type === 'error' || parsed?.type === 'turn.failed') {
      clientFailure = explainCodexFailure(parsed.message) || explainCodexFailure(parsed.error?.message) || clientFailure;
      await event({ type: parsed.type });
    } else if (['turn.started', 'turn.completed'].includes(parsed?.type)) {
      await event({ type: parsed.type });
    }
    // Tool messages, arbitrary payloads, and unknown event types are not logged.
  };
  const consume = async chunk => {
    for (const part of chunk.split(/(?<=\n)/)) {
      const ends = part.endsWith('\n');
      if (!dropping) {
        if (carry.length + part.length > 65_536) { carry = ''; dropping = true; }
        else carry += part;
      }
      if (ends) {
        if (dropping) await event({ type: 'oversized-output' });
        else if (carry.trim()) await parseLine(carry);
        carry = ''; dropping = false;
      }
    }
  };
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await checkpoint({ outputFile: path.relative(root, outputFile) });
    command ??= await findCodex();
    if (!command || /\.(cmd|bat)$/i.test(command)) throw new Error('Native Codex CLI не найден. Проверьте doctor или задайте SKAI_CODEX_EXE; shell-launcher не запускается автоматически.');
    const prompt = `Выполни задачу в корне этого репозитория. Не устанавливай системное ПО, не публикуй данные, не используй секреты и не выходи за пределы репозитория. Выполни необходимые проверки. При блокировке верни status=blocked с причиной. Финал — JSON по переданной схеме. Не включай секреты в отчёт.\n${isResume ? 'Продолжай с сохранённого состояния, не повторяй уже выполненную работу.\n' : ''}Задача:\n${task.goal}\n`;
    const result = await runProcess(command, [...prefixArgs, ...codexArgs(root, outputFile, isResume ? sessionId : null)], {
      cwd: root, input: prompt, timeoutMs, graceMs, handleSignals, signal,
      onStdout: consume, onSpawn: pid => checkpoint({ childPid: pid }),
    });
    if (carry.trim() && !dropping) await parseLine(carry);
    let raw = '';
    try {
      if ((await stat(outputFile)).size > 1_048_576) throw new Error('Отчёт превышает 1 МиБ.');
      raw = await readFile(outputFile, 'utf8');
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    const interrupted = ['timeout', 'signal'].includes(result.reason);
    const classified = classifyResult(result.code, interrupted, raw);
    if (classified.status === 'failed' && !classified.report) classified.error = clientFailure || explainCodexFailure(result.stderr) || classified.error;
    if (interrupted && result.reason === 'signal') classified.error = 'Worker остановлен пользователем.';
    if (result.error) classified.error = safeStatus(result.error.message);
    const report = classified.report ? {
      ...classified.report, summary: safeStatus(classified.report.summary),
      checks: classified.report.checks.map(safeStatus),
      filesChanged: classified.report.filesChanged.map(safeStatus),
      blockers: classified.report.blockers.map(safeStatus),
    } : null;
    if (raw) await writeFile(outputFile, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    await event({ type: 'process-exit', status: classified.status, exitCode: result.code });
    const updated = await checkpoint({
      status: classified.status, sessionId, report,
      lastExitCode: result.code, finishedAt: new Date().toISOString(),
      error: classified.error ? safeStatus(classified.error) : null, workerPid: null, childPid: null,
    });
    return { task: updated, outputFile, exitCode: interrupted ? result.reason === 'timeout' ? 124 : 130 : result.code !== 0 ? result.code : updated.status === 'completed' ? 0 : updated.status === 'blocked' ? 2 : 1 };
  } catch (error) {
    await checkpoint({ status: 'failed', sessionId, error: safeStatus(error.message), lastExitCode: 1,
      finishedAt: new Date().toISOString(), workerPid: null, childPid: null });
    throw error;
  }
}
