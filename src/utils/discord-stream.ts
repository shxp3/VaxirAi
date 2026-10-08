import type { GenerationEvent } from '../ai/types.js';
import { userError } from './errors.js';
import type { DiscordResponsePart } from './discord-response.js';
import type { RequestMetrics } from './request-metrics.js';

export type StreamPayload = DiscordResponsePart & { components?: unknown[]; allowedMentions?: { parse: never[]; repliedUser: false }; attachments?: never[] };
export interface DiscordStreamTransport {
  acknowledge(content: string): Promise<{ id?: string } | void>;
  edit(payload: StreamPayload): Promise<{ id?: string } | void>;
  send(payload: StreamPayload): Promise<{ id?: string } | void>;
}
const STATUS: Partial<Record<string, string>> = {
  request_started: '🔍 กำลังตรวจสอบคำถามและเตรียมข้อมูล...',
  search_started: '🔍 กำลังค้นหาข้อมูลที่เกี่ยวข้อง...',
  search_completed: '📚 ค้นหาข้อมูลเสร็จแล้ว กำลังเตรียมคำตอบ...',
  queue_waiting: '⏳ กำลังรอคิวผู้ให้บริการ AI...',
  generation_started: '✍️ กำลังสร้างคำตอบ...',
  formatting_response: '📝 กำลังจัดรูปแบบคำตอบ...',
};
function truncate(value: string, limit: number): string {
  let end = Math.min(value.length, limit);
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? '')) end--;
  return value.slice(0, end);
}
export class DiscordStreamRenderer {
  private answer = '';
  private status = STATUS.request_started!;
  private last = '';
  private editing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private terminal = false;
  private acknowledged = false;
  messageId?: string;
  constructor(private transport: DiscordStreamTransport, private intervalMs = 2500, private minChange = 80, private metrics?: RequestMetrics) {}
  readonly onEvent = async (event: GenerationEvent): Promise<void> => {
    if (this.terminal) return;
    if (event.type === 'progress' && event.stage === 'request_started' && !this.acknowledged) {
      const acknowledgment = await this.transport.acknowledge(this.status);
      this.messageId = acknowledgment?.id;
      this.acknowledged = true;
      this.metrics?.acknowledged();
      return;
    }
    if (event.type === 'text_delta') this.answer += event.text;
    if (event.type === 'progress' && STATUS[event.stage]) this.status = event.stage === 'search_completed' && event.found === false
      ? '🔍 การค้นหาเสร็จแล้ว ไม่พบข้อมูลที่เกี่ยวข้อง กำลังเตรียมคำตอบ...' : STATUS[event.stage]!;
    if (this.acknowledged && !this.timer && !this.editing) this.schedule();
  };
  private preview(): string {
    // Keep unfinished and complete fences out of previews; final formatting owns files.
    const code = this.answer.search(/^```/mu);
    const visible = (code < 0 ? this.answer : this.answer.slice(0, code)).trim();
    return visible ? truncate(visible, 1850) + (this.answer.length > 1850 || code >= 0 ? '\n\n✍️ กำลังสร้างคำตอบ...' : '') : this.status;
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.terminal) return;
      const next = this.preview();
      const change = Math.abs(next.length - this.last.length);
      if (next !== this.last && (!this.answer || change >= this.minChange || !this.last)) {
        this.editing = true;
        this.chain = this.chain.then(async () => {
          if (this.terminal) return;
          const edited = await this.transport.edit(this.payload({ content: next }));
          if (edited?.id) this.messageId = edited.id;
          this.last = next;
          if (this.metrics) this.metrics.edits++;
        }).catch(() => { /* Discord preview failure must not interrupt the upstream stream. */ }).finally(() => {
          this.editing = false;
          if (!this.terminal) this.schedule();
        });
      } else if (!this.terminal) this.schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }
  private payload(part: DiscordResponsePart & { components?: unknown[] }): StreamPayload {
    return { ...part, components: part.components ?? [], attachments: [], allowedMentions: { parse: [], repliedUser: false } };
  }
  private async stop(): Promise<void> {
    this.terminal = true;
    clearTimeout(this.timer);
    await this.chain;
  }
  async finish(parts: (DiscordResponsePart & { components?: unknown[] })[]): Promise<string[]> {
    await this.stop();
    const ids: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const payload = this.payload(parts[i]!);
      if (i === 0 && payload.content === this.last && !payload.files?.length && !payload.components?.length && this.messageId) {
        ids.push(this.messageId);
        continue;
      }
      const sent = i === 0 ? await this.transport.edit(payload) : await this.transport.send(payload);
      if (i === 0 && this.metrics) this.metrics.edits++;
      if (sent?.id) ids.push(sent.id);
    }
    return ids;
  }
  async fail(error: unknown): Promise<void> {
    await this.stop();
    const content = this.answer ? `${truncate(this.preview(), 1550)}\n\n⚠️ คำตอบยังไม่สมบูรณ์\n${userError(error)}` : userError(error);
    await this.transport.edit(this.payload({ content: truncate(content, 2000) }));
    if (this.metrics) this.metrics.edits++;
  }
  dispose(): void { this.terminal = true; clearTimeout(this.timer); }
}
