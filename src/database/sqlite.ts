import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Message } from '../ai/types.js';
import { conversationKey, type Conversation, type GuildSettings, type Repository } from './repository.js';
export class SqliteRepository implements Repository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (guild_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_age ON conversations(updated_at);
      CREATE INDEX IF NOT EXISTS conversations_guild ON conversations(guild_id);
      PRAGMA user_version=1;`);
  }
  async getSettings(id: string): Promise<GuildSettings | null> {
    const row = this.db.prepare('SELECT value FROM settings WHERE guild_id=?').get(id);
    return row ? JSON.parse(row.value as string) : null;
  }
  async saveSettings(id: string, settings: GuildSettings) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(settings));
  }
  async getMessages(c: Conversation, since: number): Promise<Message[]> {
    const row = this.db.prepare('SELECT value FROM conversations WHERE id=? AND updated_at>=?').get(conversationKey(c), since);
    return row ? JSON.parse(row.value as string) : [];
  }
  async saveMessages(c: Conversation, messages: Message[], updatedAt: number) {
    this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(conversationKey(c), c.guildId, JSON.stringify(messages), updatedAt);
  }
  async clearMessages(c: Conversation) { this.db.prepare('DELETE FROM conversations WHERE id=?').run(conversationKey(c)); }
  async clearGuildMessages(id: string) { this.db.prepare('DELETE FROM conversations WHERE guild_id=?').run(id); }
  async deleteGuild(id: string) { this.db.prepare('DELETE FROM settings WHERE guild_id=?').run(id); await this.clearGuildMessages(id); }
  async prune(before: number) { this.db.prepare('DELETE FROM conversations WHERE updated_at<?').run(before); }
  close() { this.db.close(); }
}
