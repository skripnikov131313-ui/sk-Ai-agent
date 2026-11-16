// Browser-test server with a protocol fixture, never an actual model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createAgentServer } from '../../src/web/server.mjs';
import { findExecutable } from '../../src/doctor.mjs';
import { runProcess } from '../../src/process.mjs';
import { registerProject } from '../../src/projects.mjs';
const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const memory = JSON.parse(await readFile(fileURLToPath(new URL('../../MEMORY.json', import.meta.url)), 'utf8'));
memory.lessons[0].problem += ' Тест отображения: <img src=x onerror="window.memoryInjected=true"> — это текст.';
await writeFile(path.join(process.argv[2], 'MEMORY.json'), JSON.stringify(memory));
const git = await findExecutable('git', process.env, { nativeOnly: true });
for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/example/browser.git']]) {
  const result = await runProcess(git, ['-C', process.argv[3], ...args], { cwd: process.argv[3], timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error('Local fixture Git setup failed');
}
await registerProject({ id: 'browser', name: 'Sk/Ai Browser', root: process.argv[3], appRoot: process.argv[2] });
const app = await createAgentServer({ root: process.argv[2], command: process.execPath,
  prefixArgs: [fixture, 'ui'], timeoutMs: 5000, graceMs: 50, worker: { platform: 'linux', desktop: false } });
console.log(JSON.stringify({ origin: app.origin }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
