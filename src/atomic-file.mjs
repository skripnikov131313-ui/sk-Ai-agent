import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows can temporarily reject replacement while a reader/scanner holds the
// destination. Keep the old database intact and retry the same atomic rename.
// Never emulate replacement with unlink + rename, which would lose atomicity.
export async function replaceFile(source, destination, {
  platform = process.platform, renameFile = rename, maxAttempts = 100, retryDelayMs = 20,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(source, destination); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
          attempt + 1 >= maxAttempts) throw error;
      await delay(retryDelayMs);
    }
  }
}
