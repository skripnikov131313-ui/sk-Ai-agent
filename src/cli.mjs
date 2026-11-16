import path from 'node:path';
import { addTask, DATA_DIR, ROOT, readTasks, recoverStore } from './store.mjs';
import { diagnose } from './doctor.mjs';
import { executeTask, recoverTask } from './runner.mjs';
import { safeStatus } from './privacy.mjs';
import { smoke } from './smoke.mjs';
import { localSession } from './local.mjs';
import { work, WORK_DB } from './work.mjs';
import { parseWorkOptions } from './work-options.mjs';
import { backgroundStatus, startBackground, stopBackground, recoverBackground } from './background.mjs';
import { createAgentServer } from './web/server.mjs';
import { runProcess } from './process.mjs';
import { createWorkerProfile, evaluateTaskRoute } from './routing.mjs';
import { parseTaskOptions } from './task-options.mjs';
import { readProjectMemory, summarizeOutcomes } from './memory.mjs';
import { loadProjectCatalog, registerProject } from './projects.mjs';

const HELP = `Sk/Ai Agent — ограниченный исполнитель (MVP)

Из корня репозитория:
  node src/cli.mjs doctor
  node src/cli.mjs memory
  node src/cli.mjs projects list
  node src/cli.mjs projects add <id> <папка Git проекта> [--name <название>]
  node src/cli.mjs local
  node src/cli.mjs ui [--port 8741] [--open] [--paused] [--desktop]
  node src/cli.mjs work [план.md] [--minutes N] [--max-tasks N] [--retry-blocked] [--desktop]
  node src/cli.mjs work-start [те же параметры]
  node src/cli.mjs work-stop
  node src/cli.mjs work-status
  node src/cli.mjs work-recover
  node src/cli.mjs smoke
  node src/cli.mjs add [--target current|windows|windows-gui] [--after UUID] <текст задачи>
  node src/cli.mjs list
  node src/cli.mjs show <id>
  node src/cli.mjs run <id> [--desktop]
  node src/cli.mjs resume <id> [--desktop]
  node src/cli.mjs recover <id>
  node src/cli.mjs recover-store

Каждая попытка: workspace-write в корне проекта, до 10 минут.
Не более трёх попыток на задачу. work сам переходит между пунктами плана;
весь исходный план без общего таймера по умолчанию. work-start запускает отдельный процесс.
run/resume остаются отдельными командами.
Ctrl+C останавливает worker и дочерние процессы. Cloud-сессия имеет собственные лимиты.`;

async function main([command, ...args]) {
  if (command === 'projects') {
    const [action, id, root, ...extra] = args;
    if (action === 'list' && args.length === 1) {
      const projects = await loadProjectCatalog();
      console.log(JSON.stringify(projects.map(item => ({ id: item.id, name: item.name, root: item.root, repository: item.repository })), null, 2));
      return;
    }
    if (action !== 'add' || !id || !root || (extra.length && !(extra.length === 2 && extra[0] === '--name'))) throw new Error('projects: list либо add <id> <папка> [--name <название>].');
    const saved = await registerProject({ id, root, name: extra[1] ?? path.basename(path.resolve(root)) });
    console.log(`Проект ${saved.id} зарегистрирован. Перезапустите панель, чтобы обновить список проектов.`);
    return;
  }
  if (command === 'memory') {
    if (args.length) throw new Error('memory не принимает аргументы и не изменяет файлы.');
    const [memory, queue, plan] = await Promise.all([readProjectMemory(ROOT), readTasks(), readTasks(WORK_DB)]);
    console.log(JSON.stringify({ ...memory, outcomes: { queue: summarizeOutcomes(queue.tasks), plan: summarizeOutcomes(plan.tasks) } }, null, 2));
    return;
  }
  if (command === 'ui') {
    let port = 8741;
    let open = false;
    let paused = false;
    let desktop = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--port') {
        port = Number(args[++index]);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port: целое число от 0 до 65535.');
      } else if (args[index] === '--open') open = true;
      else if (args[index] === '--paused') paused = true;
      else if (args[index] === '--desktop') desktop = true;
      else throw new Error(`Неизвестный аргумент ui: ${args[index]}`);
    }
    const app = await createAgentServer({ port, executionEnabled: !paused, desktop });
    let closing;
    const shutdown = () => {
      if (closing) return;
      closing = app.close().catch(error => { console.error(safeStatus(error.message)); process.exitCode = 1; })
        .finally(() => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(`Sk/Ai Agent UI: ${app.origin}\nCtrl+C — остановить панель и её текущую задачу. Закрытие вкладки не останавливает очередь.`);
    if (paused) console.log('Запуск Codex приостановлен; задачи можно создавать и просматривать.');
    if (open && process.platform === 'win32') {
      await runProcess('cmd.exe', ['/d', '/c', 'start', '', app.origin], { cwd: ROOT, timeoutMs: 10_000 });
    }
    return;
  }
  if (command === 'work' || command === 'work-start') {
    const options = parseWorkOptions(args);
    createWorkerProfile({ desktop: options.desktop ?? false });
    console.log(safeStatus(`Работа по ${options.source}: ${options.budgetMs === null ? 'без общего таймера' : `до ${options.budgetMs / 60_000} минут`}, ${options.maxTasks === 100 ? 'весь исходный план' : `до ${options.maxTasks} пунктов`}, до 3 попыток на пункт.`));
    if (command === 'work-start') {
      const state = await startBackground(options);
      console.log(safeStatus(`Фоновый процесс ${state.status}. PID: ${state.pid}. Журнал: ${state.logFile}\nСостояние: work-status; остановка: work-stop.${state.reason ? `\n${state.reason}` : ''}`));
      process.exitCode = ['running', 'completed', 'paused'].includes(state.status) ? 0 : state.exitCode ?? 1;
      return;
    }
    const result = await work({ ...options, handleSignals: true,
      onProgress: event => console.log(safeStatus(`${event.type}: ${event.text}${event.attempt ? ` (попытка ${event.attempt})` : ''}${event.error ? ` — ${event.error}` : ''}`)),
    });
    console.log(`${result.status}: ${result.reason}\nПрогресс: ${path.relative(ROOT, WORK_DB)}; команда work-status.`);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'work-status') {
    const db = await readTasks(WORK_DB);
    console.log(safeStatus(JSON.stringify({ service: await backgroundStatus(), controller: db.controller ?? null, tasks: db.tasks.map(task => ({
      id: task.id, status: task.status, attempts: task.attempts, text: task.work?.text,
      target: task.target ?? 'current', waitingReason: task.waitingReason,
      verified: task.work?.verified, error: task.error, checks: task.report?.checks,
    })) }, null, 2)));
    return;
  }
  if (command === 'work-stop') {
    const state = await stopBackground();
    console.log(safeStatus(state ? `${state.status}: ${state.reason ?? 'Фоновый процесс завершён.'}` : 'Фонового процесса нет.'));
    return;
  }
  if (command === 'work-recover') {
    await recoverBackground();
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
    const { goal, requirements } = parseTaskOptions(args);
    const task = await addTask(goal, undefined, requirements);
    return console.log(`Добавлено: ${task.id} (${task.status})\n${safeStatus(task.goal)}${task.waitingReason ? `\n${task.waitingReason.message}` : ''}`);
  }
  if (command === 'list' || command === 'show') {
    const { tasks } = await readTasks();
    if (command === 'show') {
      const task = tasks.find(item => item.id === args[0]);
      if (!task) throw new Error('Задача не найдена.');
      return console.log(safeStatus(JSON.stringify(task, null, 2)));
    }
    if (!tasks.length) return console.log('Очередь пуста.');
    for (const task of tasks) {
      const route = evaluateTaskRoute(task, tasks);
      const status = ['queued', 'waiting'].includes(task.status) ? route.eligible ? 'queued' : 'waiting' : task.status;
      console.log(`${task.id}  ${status.padEnd(11)} [${task.target ?? 'current'}] ${safeStatus(task.goal).replace(/\s+/g, ' ').slice(0, 100)}${status === 'waiting' ? ` — ${route.message}` : ''}`);
    }
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
    if (args.slice(1).some(argument => argument !== '--desktop')) throw new Error('run/resume: UUID задачи и необязательный --desktop.');
    const result = await executeTask(args[0], command === 'resume', { handleSignals: true, desktop: args.includes('--desktop') });
    console.log(`Задача ${result.task.status}.${result.outputFile ? ` Отчёт: ${path.relative(ROOT, result.outputFile)}` : ''}`);
    if (result.task.waitingReason) console.log(safeStatus(result.task.waitingReason.message));
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
