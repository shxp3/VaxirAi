import { AppError } from '../utils/errors.js';
// Only fixed categories and strictly formatted trace IDs; never log URLs, headers or bodies.
function logHttpFailure(response: Response, requestHeaders: Record<string, string>): void {
  const secrets = Object.values(requestHeaders).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]).filter(Boolean);
  const trace = (name: string, pattern: RegExp) => {
    const value = response.headers.get(name) ?? '';
    return pattern.test(value) && !secrets.some(secret => value.includes(secret)) ? value : undefined;
  };
  console.log(JSON.stringify({
    time: new Date().toISOString(), event: 'upstream_http_failed', status: response.status,
    responseType: response.headers.get('content-type')?.toLowerCase().includes('json') ? 'json' : 'non_json',
    cfRay: trace('cf-ray', /^[a-f0-9]{16}-[A-Z]{3}$/i),
    requestId: trace('x-request-id', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  }));
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 86400) : undefined;
}
export async function requestJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, transport = (url: string, init: RequestInit) => fetch(url, init)): Promise<any> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      logHttpFailure(response, headers);
      await response.body?.cancel();
      if (response.status === 429) throw new AppError('quota', retryAfter(response.headers.get('retry-after')));
      if (response.status === 413) throw new AppError('too_large');
      if (response.status === 403 && !contentType.includes('json')) throw new AppError('gateway_blocked', retryAfter(response.headers.get('retry-after')));
      if ([401, 403].includes(response.status)) throw new AppError('auth');
      if ([400, 404, 422].includes(response.status)) throw new AppError('model');
      throw new AppError('unavailable');
    }
    // Bound response buffering even if a custom service sends an oversized body.
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('malformed');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) { await reader.cancel(); throw new AppError('malformed'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('malformed'); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) throw new AppError('timeout');
    throw new AppError('unavailable');
  }
}
export function answerText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('malformed');
  return value.trim().slice(0, maxChars);
}
