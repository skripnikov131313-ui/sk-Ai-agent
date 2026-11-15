import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const [mode, ...args] = process.argv.slice(2);
const root = args[args.indexOf('--cd') + 1];
await writeFile(path.join(root, 'local-invocation.json'), JSON.stringify({ args, cwd: process.cwd() }));
if (mode === 'wait') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'fail') process.exitCode = 7;
