import path from 'node:path';
import { addTask, DATA_DIR, ROOT, readTasks, recoverStore } from './store.mjs';
import { diagnose } from './doctor.mjs';
import { executeTask, recoverTask } from './runner.mjs';
import { safeStatus } from './privacy.mjs';
import { smoke } from './smoke.mjs';
import { localSession } from './local.mjs';
import { work, WORK_DB } from './work.mjs';

const HELP = `Sk/Ai Agent — ограниченный исполнитель (MVP)

Из корня репозитория:
  node src/cli.mjs doctor
  node src/cli.mjs local
  node src/cli.mjs work [план.md] [--minutes 60] [--retry-blocked]
  node src/cli.mjs work-status
  node src/cli.mjs work-recover
  node src/cli.mjs smoke
  node src/cli.mjs add <текст задачи>
  node src/cli.mjs list
  node src/cli.mjs show <id>
  node src/cli.mjs run <id>
  node src/cli.mjs resume <id>
  node src/cli.mjs recover <id>
  node src/cli.mjs recover-store

Каждая попытка: workspace-write в корне проекта, до 10 минут.
Не более трёх попыток на задачу. work сам переходит между пунктами плана;
до 8 пунктов и 60 минут по умолчанию. run/resume остаются отдельными командами.
Ctrl+C останавливает worker и дочерние процессы. Cloud-сессия имеет собственные лимиты.`;

async function main([command, ...args]) {
  if (command === 'work') {
    let source = 'TASKS.md';
    let minutes = 60;
    let retryBlocked = false;
    let hasSource = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--minutes') {
        minutes = Number(args[++i]);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('--minutes: целое число от 1 до 240.');
      } else if (args[i] === '--retry-blocked') retryBlocked = true;
      else if (!args[i].startsWith('-') && !hasSource) { source = args[i]; hasSource = true; }
      else throw new Error(`Неизвестный аргумент work: ${args[i]}`);
    }
    console.log(`Работа по ${source}: до ${minutes} минут, до 8 независимых пунктов, до 3 попыток на пункт. Ctrl+C — остановка.`);
    const result = await work({ source, budgetMs: minutes * 60_000, retryBlocked, handleSignals: true,
      onProgress: event => console.log(safeStatus(`${event.type}: ${event.text}${event.attempt ? ` (попытка ${event.attempt})` : ''}${event.error ? ` — ${event.error}` : ''}`)),
    });
    console.log(`${result.status}: ${result.reason}\nПрогресс: ${path.relative(ROOT, WORK_DB)}; команда work-status.`);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'work-status') {
    const db = await readTasks(WORK_DB);
    console.log(safeStatus(JSON.stringify({ controller: db.controller ?? null, tasks: db.tasks.map(task => ({
      id: task.id, status: task.status, attempts: task.attempts, text: task.work?.text,
      verified: task.work?.verified, error: task.error, checks: task.report?.checks,
    })) }, null, 2)));
    return;
  }
  if (command === 'work-recover') {
    await recoverStore(`${WORK_DB}.work`);
    await recoverStore(WORK_DB);
    for (const task of (await readTasks(WORK_DB)).tasks) {
      if (task.status === 'running') await recoverTask(task.id, WORK_DB);
    }
    console.log('Остановленные процессы восстановлены. Следующий work продолжит сохранённые сессии.');
    return;
  }
  if (command === 'local') {
    if (process.platform !== 'win32') throw new Error('Команду local нужно запускать в терминале Windows-ПК. Этот Cloud-чат остаётся в облаке.');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Откройте обычное окно терминала Windows и выполните agent.cmd local без перенаправления вывода.');
    console.log('Открываю локальный Codex в этом проекте. Он выполняет команды на Windows-ПК. Лимит сессии — 10 минут.');
    const result = await localSession();
    console.log(result.reason === 'timeout' ? 'Локальная сессия остановлена по лимиту 10 минут.' : 'Локальная сессия Codex закрыта.');
    if (result.error) console.error(safeStatus(result.error.message));
    process.exitCode = result.reason === 'timeout' ? 124 : result.reason === 'signal' ? 130 : result.code;
    return;
  }
  if (command === 'doctor') return console.log(JSON.stringify(await diagnose(ROOT, DATA_DIR), null, 2));
  if (command === 'smoke') {
    console.log('Smoke: одна задача Codex, до 10 минут. Проверяем создание свежего файла внутри проекта.');
    const result = await smoke({ handleSignals: true });
    console.log(`Smoke ${result.verified ? 'PASS' : 'NOT PASSED'}. Задача: ${result.task.id}. Статус: ${result.task.status}.`);
    if (result.task.error) console.error(safeStatus(result.task.error));
    console.log(`Подробности: node src/cli.mjs show ${result.task.id}`);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'add') {
    const task = await addTask(args.join(' '));
    return console.log(`Добавлено: ${task.id}\n${safeStatus(task.goal)}`);
  }
  if (command === 'list' || command === 'show') {
    const { tasks } = await readTasks();
    if (command === 'show') {
      const task = tasks.find(item => item.id === args[0]);
      if (!task) throw new Error('Задача не найдена.');
      return console.log(safeStatus(JSON.stringify(task, null, 2)));
    }
    if (!tasks.length) return console.log('Очередь пуста.');
    for (const task of tasks) console.log(`${task.id}  ${task.status.padEnd(11)} ${safeStatus(task.goal).replace(/\s+/g, ' ').slice(0, 100)}`);
    return;
  }
  if (command === 'recover-store') {
    return console.log(await recoverStore() ? 'Блокировка остановленного процесса снята.' : 'Блокировки нет.');
  }
  if (command === 'recover') {
    const task = await recoverTask(args[0]);
    return console.log(`${task.id}  ${task.status}. Для продолжения выполните resume.`);
  }
  if (command === 'run' || command === 'resume') {
    const result = await executeTask(args[0], command === 'resume', { handleSignals: true });
    console.log(`Задача ${result.task.status}. Отчёт: ${path.relative(ROOT, result.outputFile)}`);
    if (result.task.error) console.error(safeStatus(result.task.error));
    process.exitCode = result.exitCode;
    return;
  }
  if (command && !['help', '--help', '-h'].includes(command)) throw new Error(`Неизвестная команда: ${command}`);
  console.log(HELP);
}

main(process.argv.slice(2)).catch(error => {
  console.error(safeStatus(error.message));
  process.exitCode = 1;
});
