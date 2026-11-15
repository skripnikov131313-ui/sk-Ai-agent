// Protocol fixture, not an AI executor or a test of the Codex sandbox.
import { writeFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'descendant') {
  process.on('SIGTERM', () => {});
  await writeFile(args[0], String(process.pid));
  setInterval(() => { appendFile(args[1], '.').catch(() => {}); }, 20);
} else {
  const option = name => args[args.indexOf(name) + 1];
  const output = option('--output-last-message');
  const root = option('--cd');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  await writeFile(path.join(root, 'invocation.json'), JSON.stringify({ args, cwd: process.cwd(), prompt }));
  const sessionId = '12345678-1234-4321-8123-123456789abc';
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', text: 'SYNTHETIC_SECRET_DO_NOT_LOG' })}\n`);
  if (mode === 'tree') {
    process.on('SIGTERM', () => {});
    spawn(process.execPath, [import.meta.filename, 'descendant', path.join(root, 'child.pid'), path.join(root, 'heartbeat')], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  } else if (mode === 'hold') {
    setInterval(() => {}, 1000);
  } else if (mode === 'no-report') {
    // A resumed process may exit without producing its own last message.
  } else if (mode === 'bad-report') {
    await writeFile(output, '{broken JSON');
  } else {
    if (mode === 'oversized') process.stdout.write('x'.repeat(200_000) + '\n');
    const status = mode === 'smoke-blocked' ? 'blocked' : mode === 'credential-report' ? 'failed' : ['blocked', 'failed'].includes(mode) ? mode : 'completed';
    if (['smoke', 'smoke-wrong'].includes(mode)) {
      const file = /^SMOKE_FILE=(.+)$/m.exec(prompt)?.[1];
      const marker = /^SMOKE_MARKER=(.+)$/m.exec(prompt)?.[1];
      if (!file || !marker) throw new Error('Missing fixture smoke metadata');
      await writeFile(path.join(root, file), mode === 'smoke-wrong' ? 'wrong marker\n' : `${marker}\n`);
    } else {
      await writeFile(path.join(root, 'fixture-result.txt'), 'protocol fixture changed this file\n');
    }
    await writeFile(output, JSON.stringify({ status, summary: mode === 'credential-report' ? 'api_key="SYNTHETIC_PASSWORD"' : 'Protocol fixture result',
      checks: ['fixture ran'], filesChanged: ['fixture-result.txt'], blockers: status === 'blocked' ? ['synthetic blocker'] : [] }));
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }));
    if (mode === 'nonzero') process.exitCode = 7;
  }
}
