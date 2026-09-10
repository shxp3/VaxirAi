import { AppError } from '../utils/errors.js';
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
      await response.body?.cancel();
      if (response.status === 429) throw new AppError('quota', retryAfter(response.headers.get('retry-after')));
      if (response.status === 413) throw new AppError('too_large');
      if (response.status === 403 && !contentType.includes('json')) throw new AppError('gateway_blocked');
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
