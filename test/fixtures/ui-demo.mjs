// Browser-test server with a protocol fixture, never an actual model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentServer } from '../../src/web/server.mjs';
const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const app = await createAgentServer({ root: process.argv[2], command: process.execPath,
  prefixArgs: [fixture, 'ui'], timeoutMs: 5000, graceMs: 50 });
console.log(JSON.stringify({ origin: app.origin }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
