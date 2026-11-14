import path from 'node:path';
import { addTask, DATA_DIR, ROOT, readTasks, recoverStore } from './store.mjs';
import { diagnose } from './doctor.mjs';
import { executeTask, recoverTask } from './runner.mjs';
import { safeStatus } from './privacy.mjs';

const HELP = `Sk/Ai Agent — ограниченный исполнитель (MVP)

Из корня репозитория:
  node src/cli.mjs doctor
  node src/cli.mjs add <текст задачи>
  node src/cli.mjs list
  node src/cli.mjs show <id>
  node src/cli.mjs run <id>
  node src/cli.mjs resume <id>
  node src/cli.mjs recover <id>
  node src/cli.mjs recover-store

Каждая попытка: workspace-write в корне проекта, до 10 минут.
Не более трёх попыток на задачу. Повторы и восстановление только вручную.
Ctrl+C останавливает worker и дочерние процессы. Cloud-сессия имеет собственные лимиты.`;

async function main([command, ...args]) {
  if (command === 'doctor') return console.log(JSON.stringify(await diagnose(ROOT, DATA_DIR), null, 2));
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
