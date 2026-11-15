// Classify only known client diagnostics. Never retain the raw provider/tool
// payload: it can contain credentials or page content.
export function explainCodexFailure(message) {
  if (typeof message !== 'string') return null;
  if (/access token could not be refreshed|could not parse your authentication token/i.test(message)) return 'Codex требует повторного входа в этой рабочей среде.';
  if (/(?:^|\n)Error:[^\n]*(?:read-only file system|EROFS)/i.test(message)) return 'Codex не может записать свои служебные файлы: каталог доступен только для чтения.';
  if (/CONNECT tunnel failed|proxy tunnel failed/i.test(message)) return 'Прокси рабочей среды отклонил соединение Codex.';
  if (/you(?:'|’)ve hit your usage limit|quota has been exceeded|rate limit exceeded/i.test(message)) return 'Исполнитель сообщил об ограничении квоты. Повторный запуск приостановлен.';
  return null;
}

export function classifyResult(exitCode, timedOut, rawMessage) {
  if (timedOut) return { status: 'interrupted', report: null, error: 'Истёк лимит времени.' };
  if (exitCode !== 0) return { status: 'failed', report: null, error: `Codex завершился с кодом ${exitCode}.` };
  try {
    const report = JSON.parse(rawMessage);
    if (!['completed', 'blocked', 'failed'].includes(report.status)) throw new Error('unknown task status');
    const fields = ['status', 'summary', 'checks', 'filesChanged', 'blockers'];
    if (typeof report.summary !== 'string' ||
        Object.keys(report).some(key => !fields.includes(key)) ||
        !['checks', 'filesChanged', 'blockers'].every(key =>
          Array.isArray(report[key]) && report[key].every(item => typeof item === 'string'))) {
      throw new Error('invalid report shape');
    }
    return { status: report.status, report, error: report.status === 'failed' ? report.summary : undefined };
  } catch {
    return { status: 'failed', report: null, error: 'Не удалось разобрать структурированный отчёт Codex.' };
  }
}
