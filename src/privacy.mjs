// Diagnostic output is deliberately small; arbitrary tool output is never an event.
export function safeStatus(text) {
  return String(text)
    .replace(/\bsk-[a-z0-9_-]{16,}/gi, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)\b/gi, '[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
