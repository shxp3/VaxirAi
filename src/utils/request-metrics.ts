import { randomUUID } from 'node:crypto';
import type { GenerationEvent, ProviderName } from '../ai/types.js';

// Fixed operational fields only. No user/guild identifiers, models or content.
export class RequestMetrics {
  private marks = new Map<string, number>();
  private outcome: 'completed' | 'failed' | 'timed_out' | 'cancelled' = 'failed';
  readonly id = randomUUID();
  provider?: ProviderName;
  edits = 0;
  constructor(private readonly start = Date.now(), acknowledgedAt?: number) {
    if (acknowledgedAt !== undefined) this.marks.set('acknowledged', acknowledgedAt);
  }
  note(event: GenerationEvent): void {
    if (event.type !== 'progress') return;
    if (!this.marks.has(event.stage)) this.marks.set(event.stage, Date.now());
  }
  acknowledged(): void { if (!this.marks.has('acknowledged')) this.marks.set('acknowledged', Date.now()); }
  end(code?: string): void {
    this.outcome = code === undefined ? 'completed' : code === 'timeout' ? 'timed_out' : code === 'cancelled' ? 'cancelled' : 'failed';
    this.marks.set('end', Date.now());
  }
  snapshot() {
    const elapsed = (end: string, start?: string) => {
      const to = this.marks.get(end), from = start ? this.marks.get(start) : this.start;
      return to === undefined || from === undefined ? undefined : Math.max(0, to - from);
    };
    return { event: 'request_performance', requestId: this.id, provider: this.provider, outcome: this.outcome,
      acknowledgmentMs: elapsed('acknowledged'), searchMs: elapsed('search_completed', 'search_started'),
      queueWaitMs: elapsed('generation_started', 'queue_waiting'), connectionMs: elapsed('connected', 'generation_started'),
      firstByteMs: elapsed('first_byte', 'generation_started'), firstOutputMs: elapsed('first_output', 'generation_started'),
      generationMs: elapsed('formatting_response', 'generation_started'), totalMs: elapsed('end'), discordEdits: this.edits };
  }
  log(): void { console.log(JSON.stringify(this.snapshot())); }
}
