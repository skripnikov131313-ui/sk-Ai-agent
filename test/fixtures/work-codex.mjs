// Deterministic dispatcher protocol fixture. Never calls a model or a network.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const root = args[args.indexOf('--cd') + 1];
const output = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const text = /\n(CASE=[^\n]+)\n/.exec(prompt)?.[1];
if (!text) throw new Error('Missing fixture case');
const historyFile = path.join(root, 'invocations.jsonl');
let history = '';
try { history = await readFile(historyFile, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const attempt = history.split('\n').filter(line => line && JSON.parse(line).text === text).length + 1;
await appendFile(historyFile, `${JSON.stringify({ text, attempt, args })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: '12345678-1234-4321-8123-123456789abc' })}\n`);
if (text === 'CASE=hold' || (text === 'CASE=timeout' && attempt === 1)) {
  setInterval(() => {}, 1000);
} else if (text !== 'CASE=no-report') {
  const blocked = text === 'CASE=blocked';
  const failed = text === 'CASE=failed' && attempt === 1;
  const incomplete = text === 'CASE=incomplete' || (text === 'CASE=repair' && attempt === 1);
  const planFile = path.join(root, 'PLAN.md');
  let plan = await readFile(planFile, 'utf8');
  if (!blocked && !failed && !incomplete) plan = plan.replace(`- [ ] ${text}`, `- [x] ${text}`);
  if (text === 'CASE=grow') plan += '\n- [ ] CASE=unplanned\n';
  await writeFile(planFile, plan);
  await writeFile(output, JSON.stringify({ status: blocked ? 'blocked' : failed ? 'failed' : 'completed',
    summary: 'Dispatcher fixture result', checks: incomplete ? [] : ['fixture check passed'],
    filesChanged: ['PLAN.md'], blockers: blocked ? ['fixture blocker'] : [] }));
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}
