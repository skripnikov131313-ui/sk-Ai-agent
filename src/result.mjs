export function classifyResult(exitCode, timedOut, rawMessage) {
  if (timedOut) return { status: 'interrupted', report: null, error: 'Истёк лимит времени.' };
  if (exitCode !== 0) return { status: 'failed', report: null, error: `Codex завершился с кодом ${exitCode}.` };
  try {
    const report = JSON.parse(rawMessage);
    if (!['completed', 'blocked', 'failed'].includes(report.status)) throw new Error('unknown task status');
    if (typeof report.summary !== 'string' || !Array.isArray(report.checks) ||
        !Array.isArray(report.filesChanged) || !Array.isArray(report.blockers)) {
      throw new Error('invalid report shape');
    }
    return { status: report.status, report, error: report.status === 'failed' ? report.summary : undefined };
  } catch {
    return { status: 'failed', report: null, error: 'Не удалось разобрать структурированный отчёт Codex.' };
  }
}
