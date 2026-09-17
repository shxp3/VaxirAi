import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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

  async run<T>(key: string, timeoutMs: number, intervalMs: number, task: (remainingMs: number) => Promise<T>): Promise<T> {
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
    const deadline = now + timeoutMs;
    state.pending++;
    const job = state.tail.then(async () => {
      checkCooldown();
      if (Math.max(Date.now(), state.nextStart) >= deadline) throw new AppError('timeout');
      while (state.nextStart > Date.now()) await delay(state.nextStart - Date.now());
      checkCooldown();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('timeout');
      state.nextStart = Date.now() + intervalMs;
      try { return await task(remaining); }
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
    // A queued caller times out promptly; its expired job will never call the API.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([job, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('timeout')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}

const sharedQueue = new ProviderRequestQueue();
export function queuedProvider(provider: AIProvider, intervalMs = 3000, queue = sharedQueue): AIProvider {
  const generate: AIProvider['generate'] = (messages, config, settings) => queue.run(providerQueueKey(config), settings.timeoutMs, intervalMs,
    remainingMs => provider.generate(messages, config, { ...settings, timeoutMs: remainingMs }));
  // Preserve adapter identity for callers that inspect the resolved API protocol.
  return new Proxy(provider, { get: (target, property, receiver) => property === 'generate' ? generate : Reflect.get(target, property, receiver) });
}
