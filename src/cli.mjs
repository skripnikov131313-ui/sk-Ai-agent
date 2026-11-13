import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTask, DATA_DIR, ROOT, TASKS_FILE, readTasks, updateTask } from './store.mjs';
import { classifyResult } from './result.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 10 * 60 * 1000;
const TASK_ROOT = path.join(DATA_DIR, 'runs');
const HELP = `Sk/Ai Agent — локальный исполнитель (MVP)

Команды:
  node agent/src/cli.mjs doctor
  node agent/src/cli.mjs add <текст задачи>
  node agent/src/cli.mjs list
  node agent/src/cli.mjs run <id>
  node agent/src/cli.mjs resume <id>

Запуск ограничен репозиторием, sandbox workspace-write и 10 минутами. Автоматических повторов нет.`;

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function safeStatus(text) {
  return text
    .replace(/(sk-[a-z0-9_-]{16,})/gi, '[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

async function doctor() {
  const found = {};
  for (const bin of ['node', 'git', 'codex', 'gh', 'cmake', 'dotnet']) {
    const result = await runCommand('where.exe', [bin], { cwd: ROOT });
    found[bin] = result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
  }
  const login = found.codex ? await runCommand('codex', ['login', 'status'], { cwd: ROOT }) : { code: 127, stdout: '', stderr: '' };
  const result = {
    checkedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.arch()}`,
    memoryTotalGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    memoryFreeGiB: +(os.freemem() / 1024 ** 3).toFixed(1),
    tools: found,
    codexAuthentication: login.code === 0 ? 'available' : 'not confirmed',
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'doctor.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

async function listTasks() {
  const { tasks } = await readTasks();
  if (!tasks.length) return console.log('Очередь пуста.');
  for (const task of tasks) {
    console.log(`${task.id}  ${task.status.padEnd(11)} ${task.goal.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
}

async function executeTask(id, isResume) {
  const db = await readTasks();
  const task = db.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Задача не найдена: ${id}`);
  if (task.status === 'running') throw new Error('Эта задача уже помечена как выполняющаяся. Проверьте процесс и журнал.');
  if (isResume && !['interrupted', 'failed', 'blocked'].includes(task.status)) throw new Error('Возобновить можно только прерванную, заблокированную или завершившуюся ошибкой задачу.');
  if (isResume && !task.sessionId) throw new Error('У задачи нет сохранённой сессии Codex; создайте новую задачу.');
  if (!isResume && task.status !== 'queued') throw new Error('Для повторного запуска используйте отдельную новую задачу.');

  const runDir = path.join(TASK_ROOT, task.id);
  await mkdir(runDir, { recursive: true });
  const eventFile = path.join(runDir, 'events.jsonl');
  const outputFile = path.join(runDir, 'last-message.md');
  const promptFile = path.join(runDir, 'prompt.txt');
  const prompt = `Выполни задачу пользователя в корне этого репозитория. Сначала осмотри проект и делай небольшие проверяемые изменения. Не устанавливай системное ПО, не публикуй данные и не используй секреты. Не выходи за пределы этого репозитория. Выполни необходимые проверки. Если не можешь прочитать проект, запустить требуемые проверки или безопасно завершить задачу, укажи status=blocked и объясни причину; не выдавай незавершённую задачу за успех. В финале верни строго JSON по переданной JSON Schema: status, summary, checks, filesChanged, blockers.\n\n${isResume ? 'Продолжай задачу с сохранённого состояния и не повторяй уже завершённую работу. ' : ''}Задача:\n${task.goal}\n`;
  await writeFile(promptFile, prompt, 'utf8');
  await updateTask(id, { status: 'running', attempts: task.attempts + 1, startedAt: new Date().toISOString(), lastExitCode: null });
  const args = isResume
    ? ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '--output-schema', path.join(here, '..', 'task-output.schema.json'), '--output-last-message', outputFile, task.sessionId, '-']
    : ['exec', '--json', '--sandbox', 'workspace-write', '--cd', ROOT, '--output-schema', path.join(here, '..', 'task-output.schema.json'), '--output-last-message', outputFile, '-'];

  const child = spawn('codex', args, { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
  let carry = '';
  let stderr = '';
  let sessionId = task.sessionId;
  const logEvents = async chunk => {
    carry += chunk.toString();
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
        const clean = { type: event.type ?? 'event', timestamp: new Date().toISOString() };
        if (event.type === 'turn.completed') clean.status = event.status ?? 'completed';
        if (event.type === 'turn.failed') clean.status = 'failed';
        await appendFile(eventFile, `${JSON.stringify(clean)}\n`, 'utf8');
      } catch {
        await appendFile(eventFile, `${JSON.stringify({ type: 'unparsed-output', timestamp: new Date().toISOString() })}\n`, 'utf8');
      }
    }
  };
  let eventWrites = Promise.resolve();
  child.stdout.on('data', chunk => { eventWrites = eventWrites.then(() => logEvents(chunk)); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let timer;
  let didTimeOut = false;
  timer = setTimeout(() => {
    didTimeOut = true;
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } else child.kill('SIGTERM');
  }, TIMEOUT_MS);
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ code: 127, error }));
    child.once('close', code => resolve({ code: code ?? 1 }));
  });
  let result;
  try { result = await exited; }
  finally { clearTimeout(timer); }
  await eventWrites;
  if (carry.trim()) await logEvents('\n');
  let rawMessage = '';
  try { rawMessage = await (await import('node:fs/promises')).readFile(outputFile, 'utf8'); } catch {}
  const classified = classifyResult(result.code, didTimeOut, rawMessage);
  const status = classified.status;
  if (result.code !== 0 && stderr.trim()) {
    await writeFile(path.join(runDir, 'diagnostics.txt'), safeStatus(stderr).slice(-4000), 'utf8');
  }
  const report = await updateTask(id, {
    status, sessionId, lastExitCode: result.code, finishedAt: new Date().toISOString(),
    error: result.error ? safeStatus(result.error.message) : classified.error,
  });
  await appendFile(eventFile, `${JSON.stringify({ type: 'process-exit', status, exitCode: result.code, timestamp: new Date().toISOString() })}\n`, 'utf8');
  console.log(`Задача ${report.status}. Код завершения: ${String(result.code)}. Отчёт: ${path.relative(ROOT, outputFile)}`);
  if (stderr.trim()) {
    const lines = stderr.trim().split(/\r?\n/).length;
    console.error(result.code !== 0
      ? `Сохранена очищенная диагностика Codex (${lines} строк).`
      : `Codex вывел сообщения диагностики (${lines} строк); содержимое скрыто.`);
  }
  if (didTimeOut) process.exitCode = 124;
  else if (result.code !== 0) process.exitCode = result.code || 1;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'doctor') return doctor();
  if (command === 'add') {
    const task = await addTask(args.join(' '));
    console.log(`Добавлено: ${task.id}\n${task.goal}`);
    return;
  }
  if (command === 'list') return listTasks();
  if (command === 'run') return executeTask(args[0], false);
  if (command === 'resume') return executeTask(args[0], true);
  console.log(HELP);
}

main(process.argv.slice(2)).catch(error => {
  console.error(safeStatus(error.message));
  process.exitCode = 1;
});
