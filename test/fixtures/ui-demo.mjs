// Browser-test server with a protocol fixture, never an actual model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createAgentServer } from '../../src/web/server.mjs';
const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const memory = JSON.parse(await readFile(fileURLToPath(new URL('../../MEMORY.json', import.meta.url)), 'utf8'));
memory.lessons[0].problem += ' Тест отображения: <img src=x onerror="window.memoryInjected=true"> — это текст.';
await writeFile(path.join(process.argv[2], 'MEMORY.json'), JSON.stringify(memory));
const app = await createAgentServer({ root: process.argv[2], command: process.execPath,
  prefixArgs: [fixture, 'ui'], timeoutMs: 5000, graceMs: 50, worker: { platform: 'linux', desktop: false } });
console.log(JSON.stringify({ origin: app.origin }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
