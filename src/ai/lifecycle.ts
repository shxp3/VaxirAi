import { AppError } from '../utils/errors.js';
import type { GenerationEvent, GenerationOptions } from './types.js';

export function abortError(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError ? signal.reason : new AppError('cancelled');
}
// Race even transports/mocks that do not implement AbortSignal, without leaking listeners.
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(abortError(signal));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
export function deadline(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const expires = Date.now() + timeoutMs;
  const abort = () => controller.abort(parent ? abortError(parent) : new AppError('cancelled'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new AppError('timeout')), Math.max(1, timeoutMs));
  return {
    controller, signal: controller.signal,
    remaining: () => Math.max(0, expires - Date.now()),
    close: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}
export async function emit(options: GenerationOptions | undefined, event: GenerationEvent): Promise<void> {
  if (options?.signal?.aborted) throw abortError(options.signal);
  await options?.onEvent?.(event);
}
export function shouldStream(config: { provider: string; streaming?: boolean }, options?: GenerationOptions): boolean {
  return !!options?.onEvent && (options.stream ?? config.streaming ?? config.provider !== 'custom');
}
