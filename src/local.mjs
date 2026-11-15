import { access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './store.mjs';
import { findCodex } from './doctor.mjs';
import { runProcess } from './process.mjs';

export async function localSession({
  root = ROOT, command, prefixArgs = [], timeoutMs = 600_000, handleSignals = true,
} = {}) {
  await access(path.join(root, 'docs', 'LOCAL_HANDOFF.md'));
  command ??= await findCodex();
  if (!command || /\.(cmd|bat|ps1|js)$/i.test(command)) throw new Error('Native Codex CLI не найден; выполните doctor.');
  const prompt = 'Прочитай AGENTS.md и docs/LOCAL_HANDOFF.md. Продолжи описанную там локальную Windows-работу самостоятельно через инструменты. Сохраняй пользовательские изменения. Не повторяй уже пройденные проверки без новых изменений или ошибки. Не расширяй права и не публикуй изменения без отдельного разрешения. Обнови PROGRESS.md и запиши итог в .skai-agent/local-handoff-report.md. Доступное время этой сессии — до 10 минут.';
  return runProcess(command, [...prefixArgs, '--sandbox', 'workspace-write', '--cd', root, prompt], {
    cwd: root, inheritStdio: true, timeoutMs: Math.min(timeoutMs, 600_000), handleSignals,
  });
}
