import { spawn } from 'node:child_process';

// No shell, inherited credentials, bounded diagnostics. POSIX worker commands
// get a private process group; interactive clients share the user's terminal.
// Injection of a command is only an internal testing seam.
export async function runProcess(command, args, {
  cwd, input = '', timeoutMs = 600_000, graceMs = 500,
  onStdout, onSpawn, handleSignals = false, inheritStdio = false, signal,
  env = process.env,
} = {}) {
  if (signal?.aborted) return { code: 130, stdout: '', stderr: '', reason: 'signal' };
  const grouped = process.platform !== 'win32' && !inheritStdio;
  const child = spawn(command, args, {
    cwd, env, windowsHide: !inheritStdio, detached: grouped,
    stdio: inheritStdio ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  let error;
  let stdout = '';
  let stderr = '';
  let reason = null;
  let killing = Promise.resolve();
  const killGroup = signal => {
    if (!child.pid) return;
    if (!grouped && (child.exitCode !== null || child.signalCode !== null)) return;
    try { process.kill(grouped ? -child.pid : child.pid, signal); }
    catch (failure) { if (failure.code !== 'ESRCH') error ??= failure; }
  };
  const stop = why => {
    if (reason) return;
    reason = why;
    if (process.platform === 'win32' && child.pid) {
      killing = new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        killer.once('error', failure => { error ??= failure; child.kill(); resolve(); });
        killer.once('close', code => {
          if (code !== 0) child.kill();
          resolve();
        });
      });
    } else {
      killGroup('SIGTERM');
      killing = new Promise(resolve => setTimeout(() => { killGroup('SIGKILL'); resolve(); }, graceMs));
    }
  };
  const onInterrupt = () => stop('signal');
  const exited = new Promise(resolve => {
    child.once('error', failure => { error = failure; });
    child.once('close', code => resolve(code ?? 1));
  });
  // Missing executables can close stdin before the prompt is written.
  child.stdin?.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
  if (handleSignals) {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
  }
  signal?.addEventListener('abort', onInterrupt, { once: true });
  if (signal?.aborted) onInterrupt();
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const consume = async (stream, callback) => {
    if (!stream) return;
    try { for await (const chunk of stream) await callback(chunk.toString()); }
    catch (failure) { error ??= failure; stop('io-error'); }
  };
  const output = consume(child.stdout, async chunk => {
    if (onStdout) await onStdout(chunk);
    else stdout = (stdout + chunk).slice(-16_384);
  });
  const diagnostics = consume(child.stderr, chunk => { stderr = (stderr + chunk).slice(-16_384); });
  try {
    if (child.pid && onSpawn) {
      try { await onSpawn(child.pid); }
      catch (failure) { error ??= failure; stop('io-error'); }
    }
    child.stdin?.end(input);
    const code = await exited;
    await killing;
    await Promise.all([output, diagnostics]);
    return { code: error ? 127 : code, stdout, stderr, reason, error, pid: child.pid };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onInterrupt);
    if (process.platform !== 'win32') killGroup('SIGKILL');
    if (handleSignals) {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
    }
  }
}
