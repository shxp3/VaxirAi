import { abortable, abortError, deadline, emit } from './lifecycle.js';
import type { GenerationOptions } from './types.js';
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
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface HttpOptions extends GenerationOptions { connectTimeoutMs?: number; firstByteTimeoutMs?: number; idleTimeoutMs?: number }
export async function requestBody<T>(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number,
  transport: Transport, options: HttpOptions | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = deadline(timeoutMs, options?.signal);
  let response: Response | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    scope.signal.throwIfAborted();
    connectTimer = setTimeout(() => scope.controller.abort(new AppError('timeout')), Math.min(timeoutMs, options?.connectTimeoutMs ?? timeoutMs));
    const pending = transport(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: scope.signal, redirect: 'error' });
    // Cancel a late response from a transport that ignored the signal.
    void pending.then(r => { if (scope.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    response = await abortable(pending, scope.signal);
    clearTimeout(connectTimer);
    await emit(options, { type: 'progress', stage: 'connected' });
    if (!response.ok) {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      logHttpFailure(response, headers);
      if (response.status === 429) throw new AppError('quota', retryAfter(response.headers.get('retry-after')));
      if (response.status === 413) throw new AppError('too_large');
      if (response.status === 403 && !contentType.includes('json')) throw new AppError('gateway_blocked', retryAfter(response.headers.get('retry-after')));
      if ([401, 403].includes(response.status)) throw new AppError('auth');
      if ([400, 404, 422].includes(response.status)) throw new AppError('model');
      throw new AppError('unavailable');
    }
    return await abortable(consume(response, scope.signal), scope.signal);
  } catch (error) {
    if (scope.signal.aborted) throw abortError(scope.signal);
    if (error instanceof AppError) throw error;
    throw new AppError('unavailable');
  } finally {
    clearTimeout(connectTimer);
    // Abort closes sockets as well as readers on protocol failures and early completion.
    scope.controller.abort(new AppError('cancelled'));
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    scope.close();
  }
}
export async function* responseChunks(response: Response, signal: AbortSignal, maxBytes: number, options?: HttpOptions): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('malformed');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let total = 0;
  let first = true;
  try {
    while (true) {
      const readScope = deadline(first ? options?.firstByteTimeoutMs ?? 600000 : options?.idleTimeoutMs ?? 45000, signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await abortable(reader.read(), readScope.signal); }
      finally { readScope.close(); }
      if (signal.aborted) throw abortError(signal);
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxBytes) throw new AppError('too_large');
      if (first) { first = false; await emit(options, { type: 'progress', stage: 'first_byte' }); }
      yield chunk.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function requestJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number,
  transport: Transport = (url, init) => fetch(url, init), options?: HttpOptions): Promise<any> {
  return requestBody(url, headers, body, timeoutMs, transport, options, (response, signal) => responseJson(response, signal, options));
}
export async function responseJson(response: Response, signal: AbortSignal, options?: HttpOptions): Promise<any> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const value of responseChunks(response, signal, 2_000_000, options)) chunks.push(value);
  } catch (error) {
    if (error instanceof AppError && error.code === 'too_large') throw new AppError('malformed');
    throw error;
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AppError('malformed'); }
}
export function answerText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('malformed');
  const text = value.trim();
  let end = Math.min(text.length, maxChars);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
export async function completedText(value: unknown, maxChars: number, options?: GenerationOptions): Promise<string> {
  const answer = answerText(value, maxChars);
  await emit(options, { type: 'text_delta', text: answer });
  await emit(options, { type: 'provider_completed' });
  return answer;
}
