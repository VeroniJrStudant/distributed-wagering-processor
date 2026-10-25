export function findCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    const record = current as Record<string, unknown>;
    for (const key of ['cause', 'original', 'exception', 'err']) {
      if (key in record) queue.push(record[key]);
    }
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return findCode(error) === '23505' || errorName(error).includes('UniqueConstraint');
}

export function isDeadlock(error: unknown): boolean {
  const code = findCode(error);
  return code === '40P01' || code === '40001' || code === '55P03';
}

export function isTransientInfrastructure(error: unknown): boolean {
  const code = findCode(error);
  if (code && ['08000', '08001', '08003', '08004', '08006', '57P01', '57P03', '53300', '40001', '40P01', '55P03'].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|timeout expired|sorry, too many clients/i.test(message);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name: unknown }).name);
  return '';
}
