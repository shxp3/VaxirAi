import { AppError } from '../utils/errors.js';
export class RateLimiter {
  private buckets = new Map<string, number[]>();
  constructor(private windowMs: number, private now = Date.now) {}
  consume(limits: { key: string; limit: number }[]): void {
    const now = this.now();
    for (const [key, times] of this.buckets) {
      const live = times.filter(t => t > now - this.windowMs);
      if (live.length) this.buckets.set(key, live); else this.buckets.delete(key);
    }
    for (const { key, limit } of limits) {
      const times = this.buckets.get(key) ?? [];
      if (times.length >= limit) throw new AppError('limited', Math.ceil((times[0]! + this.windowMs - now) / 1000));
    }
    for (const { key } of limits) this.buckets.set(key, [...(this.buckets.get(key) ?? []), now]);
  }
}
