import type { Message } from '../ai/types.js';
import { conversationKey, type Conversation, type GuildSettings, type Repository } from './repository.js';
export class InMemoryRepository implements Repository {
  private settings = new Map<string, GuildSettings>();
  private messages = new Map<string, { messages: Message[]; updatedAt: number }>();
  async getSettings(id: string) { return structuredClone(this.settings.get(id) ?? null); }
  async saveSettings(id: string, settings: GuildSettings) { this.settings.set(id, structuredClone(settings)); }
  async getMessages(c: Conversation, since: number) {
    const item = this.messages.get(conversationKey(c));
    return item && item.updatedAt >= since ? structuredClone(item.messages) : [];
  }
  async saveMessages(c: Conversation, messages: Message[], updatedAt: number) { this.messages.set(conversationKey(c), { messages: structuredClone(messages), updatedAt }); }
  async clearMessages(c: Conversation) { this.messages.delete(conversationKey(c)); }
  async clearGuildMessages(id: string) { for (const key of this.messages.keys()) if (key.startsWith(id + ':')) this.messages.delete(key); }
  async deleteGuild(id: string) { this.settings.delete(id); await this.clearGuildMessages(id); }
  async prune(before: number) { for (const [key, value] of this.messages) if (value.updatedAt < before) this.messages.delete(key); }
  close() {}
}
