import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { abortable, deadline, emit } from './lifecycle.js';
import type { GenerationOptions } from './types.js';
import { AppError } from '../utils/errors.js';
import type { AIProvider, ProviderConfig } from './types.js';

interface Bucket {
  tail: Promise<void>;
  pending: number;
  nextStart: number;
  blockedUntil: number;
  blockedCode: 'quota' | 'gateway_blocked';
}

// Shared across guilds and provider instances; raw credentials never enter the map.
export function providerQueueKey(config: ProviderConfig): string {
  const origin = config.provider === 'custom' ? new URL(config.baseUrl!).origin : {
    gemini: 'https://generativelanguage.googleapis.com', groq: 'https://api.groq.com', openrouter: 'https://openrouter.ai',
  }[config.provider];
  return createHash('sha256').update(JSON.stringify([origin, config.apiKey])).digest('hex');
}

export class ProviderRequestQueue {
  private buckets = new Map<string, Bucket>();

  cooldown(key: string): { code: 'quota' | 'gateway_blocked'; seconds: number } | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    const remainingMs = bucket.blockedUntil - Date.now();
    if (remainingMs <= 0) return null;
    return { code: bucket.blockedCode, seconds: Math.ceil(remainingMs / 1000) };
  }

  activeCooldowns(): number {
    const now = Date.now();
    let count = 0;
    for (const bucket of this.buckets.values()) if (bucket.blockedUntil > now) count++;
    return count;
  }

  async run<T>(key: string, timeoutMs: number, intervalMs: number, task: (remainingMs: number, signal: AbortSignal) => Promise<T>, options?: GenerationOptions): Promise<T> {
    const now = Date.now();
    for (const [id, bucket] of this.buckets) {
      if (!bucket.pending && Math.max(bucket.nextStart, bucket.blockedUntil) <= now) this.buckets.delete(id);
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 1000) throw new AppError('busy');
      bucket = { tail: Promise.resolve(), pending: 0, nextStart: 0, blockedUntil: 0, blockedCode: 'quota' };
      this.buckets.set(key, bucket);
    }
    const state = bucket;
    const checkCooldown = () => {
      if (state.blockedUntil > Date.now()) throw new AppError(state.blockedCode, Math.ceil((state.blockedUntil - Date.now()) / 1000));
    };
    checkCooldown();
    if (state.pending >= 8) throw new AppError('busy');
    const expires = now + timeoutMs;
    const scope = deadline(timeoutMs, options?.signal);
    state.pending++;
    const job = state.tail.then(async () => {
      scope.signal.throwIfAborted();
      checkCooldown();
      if (Math.max(Date.now(), state.nextStart) >= expires) throw new AppError('timeout');
      while (state.nextStart > Date.now()) await delay(state.nextStart - Date.now(), undefined, { signal: scope.signal });
      checkCooldown();
      const remaining = expires - Date.now();
      if (remaining <= 0) throw new AppError('timeout');
      state.nextStart = Date.now() + intervalMs;
      try {
        await abortable(emit({ ...options, signal: scope.signal }, { type: 'progress', stage: 'generation_started' }), scope.signal);
        return await abortable(task(remaining, scope.signal), scope.signal);
      }
      catch (error) {
        if (error instanceof AppError && (error.code === 'quota' || error.code === 'gateway_blocked')) {
          const seconds = error.retryAfter ?? (error.code === 'quota' ? 60 : 300);
          state.blockedUntil = Date.now() + seconds * 1000;
          state.blockedCode = error.code;
          throw new AppError(error.code, seconds);
        }
        throw error;
      }
    });
    state.tail = job.then(() => {}, () => {}).finally(() => { state.pending--; });
    // Caller expiry aborts active work and leaves an expired FIFO placeholder that
    // cannot execute. Other credentials use independent buckets.
    try {
      if (state.pending > 1 || state.nextStart > now) await abortable(emit(options, { type: 'progress', stage: 'queue_waiting' }), scope.signal);
      return await abortable(job, scope.signal);
    } finally { scope.controller.abort(new AppError('cancelled')); scope.close(); }
  }
}

export const sharedQueue = new ProviderRequestQueue();
export function queueCooldownForConfig(config: ProviderConfig): { code: 'quota' | 'gateway_blocked'; seconds: number } | null {
  try { return sharedQueue.cooldown(providerQueueKey(config)); } catch { return null; }
}
export function queuedProvider(provider: AIProvider, intervalMs = 3000, queue = sharedQueue): AIProvider {
  const generate: AIProvider['generate'] = (messages, config, settings, options) => queue.run(providerQueueKey(config), settings.timeoutMs, intervalMs,
    (remainingMs, signal) => provider.generate(messages, config, { ...settings, timeoutMs: remainingMs }, { ...options, signal }), options);
  // Preserve adapter identity for callers that inspect the resolved API protocol.
  return new Proxy(provider, { get: (target, property, receiver) => property === 'generate' ? generate : property === 'queued' ? true : Reflect.get(target, property, receiver) });
}
