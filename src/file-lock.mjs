import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const windowsSharingErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

// On Windows a lock being deleted can temporarily reject CREATE_NEW with an
// access/sharing error instead of EEXIST. Retry the same exclusive open only;
// never remove someone else's lock or change permissions to acquire it.
export async function acquireStoreLock(file, {
  platform = process.platform, openFile = open, maxAttempts = 100, retryDelayMs = 20,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await openFile(file, 'wx', 0o600); }
    catch (error) {
      const retryable = error.code === 'EEXIST' ||
        (platform === 'win32' && windowsSharingErrors.has(error.code));
      if (!retryable) throw error;
      lastError = error;
      if (attempt + 1 < maxAttempts) await delay(retryDelayMs);
    }
  }
  // Preserve persistent permission failures, including their code and syscall.
  if (lastError?.code !== 'EEXIST') throw lastError;
  throw new Error('Очередь занята. Если процесс остановлен, выполните recover-store.', { cause: lastError });
}
