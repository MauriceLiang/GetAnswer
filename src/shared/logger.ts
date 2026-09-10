const sensitiveKeys = new Set([
  'apikey',
  'authorization',
  'cookie',
  'localstorage',
  'token'
]);

export function sanitizeLogDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLogDetail);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeLogDetail(nested)
    ])
  );
}

export function logInfo(event: string, detail?: unknown): void {
  console.info(`[ai-learning-assistant] ${event}`, sanitizeLogDetail(detail));
}

export function logError(event: string, error?: unknown): void {
  console.error(`[ai-learning-assistant] ${event}`, sanitizeLogDetail(error));
}
