export function parseWorkOptions(args) {
  const options = { source: 'TASKS.md', budgetMs: null, maxTasks: 100, retryBlocked: false };
  let hasSource = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--minutes') {
      const minutes = Number(args[++i]);
      if (!Number.isSafeInteger(minutes) || minutes < 1 || !Number.isSafeInteger(minutes * 60_000) ||
          Date.now() + minutes * 60_000 > 8_640_000_000_000_000) throw new Error('--minutes: положительное целое число минут.');
      options.budgetMs = minutes * 60_000;
    } else if (args[i] === '--max-tasks') {
      options.maxTasks = Number(args[++i]);
      if (!Number.isInteger(options.maxTasks) || options.maxTasks < 1 || options.maxTasks > 100) throw new Error('--max-tasks: целое число от 1 до 100.');
    } else if (args[i] === '--retry-blocked') options.retryBlocked = true;
    else if (!args[i].startsWith('-') && !hasSource) { options.source = args[i]; hasSource = true; }
    else throw new Error(`Неизвестный аргумент work: ${args[i]}`);
  }
  return options;
}
