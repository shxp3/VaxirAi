import type { Message, ProviderName, ApiFormat } from '../ai/types.js';
export interface GuildSettings {
  enabled: boolean; aiChannelId: string | null; userRateLimit: number; contextMessageLimit: number;
  instructions?: string;
  ai: { provider: ProviderName; model: string; encryptedKey: string; baseUrl?: string; apiFormat?: ApiFormat } | null;
  revision: number;
}
export interface Conversation { guildId: string; channelId: string; userId: string }
export function conversationKey(c: Conversation): string { return `${c.guildId}:${c.channelId}:${c.userId}`; }
export interface Repository {
  getSettings(guildId: string): Promise<GuildSettings | null>;
  saveSettings(guildId: string, settings: GuildSettings): Promise<void>;
  getMessages(conversation: Conversation, since: number): Promise<Message[]>;
  saveMessages(conversation: Conversation, messages: Message[], updatedAt: number): Promise<void>;
  clearMessages(conversation: Conversation): Promise<void>;
  clearGuildMessages(guildId: string): Promise<void>;
  deleteGuild(guildId: string): Promise<void>;
  prune(before: number): Promise<void>;
  close(): void;
}
