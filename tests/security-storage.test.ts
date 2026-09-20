import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secrets } from '../src/config/secrets.js';
import { RateLimiter } from '../src/rate-limit/limiter.js';
import { SqliteRepository } from '../src/database/sqlite.js';
import { defaultSettings, Conversations } from '../src/memory/conversations.js';
import { readEnv } from '../src/config/env.js';
import { AdminCommands, isAdmin } from '../src/commands/admin.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { commands } from '../src/commands/definitions.js';
import { PermissionFlagsBits } from 'discord.js';
test('AI channel setup identifies disabled intent without saving settings', async () => {
  const env = readEnv({ MESSAGE_CONTENT_ENABLED: 'false' });
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  await assert.rejects(admin.handle({ inGuild: () => true, guildId: '1', memberPermissions: { has: () => true },
    isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'setup',
    options: { getSubcommand: () => 'ai-channel', getChannel: () => ({ id: '2' }) }, deferReply: async () => {},
  } as any), { code: 'intent' });
  assert.equal(await repo.getSettings('1'), null);
});
test('keys are encrypted, randomized, authenticated and bound to guild', () => {
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const encoded = secrets.encrypt('secret-api-key', '1');
  assert.ok(!encoded.includes('secret-api-key')); assert.notEqual(encoded, secrets.encrypt('secret-api-key', '1'));
  assert.equal(secrets.decrypt(encoded, '1'), 'secret-api-key');
  assert.throws(() => secrets.decrypt(encoded, '2'), { code: 'config' });
  assert.throws(() => secrets.decrypt(encoded.slice(0, -4) + 'AAAA', '1'), { code: 'config' });
  assert.throws(() => new Secrets('invalid'), { code: 'config' });
});
test('rate limits enforce sliding windows and atomically consume global capacity', () => {
  let now = 0; const limiter = new RateLimiter(60000, () => now);
  const limits = [{ key: 'user', limit: 2 }, { key: 'global', limit: 3 }];
  limiter.consume(limits); limiter.consume(limits);
  assert.throws(() => limiter.consume(limits), { code: 'limited', retryAfter: 60 });
  limiter.consume([{ key: 'other', limit: 2 }, { key: 'global', limit: 3 }]);
  assert.throws(() => limiter.consume([{ key: 'third', limit: 2 }, { key: 'global', limit: 3 }]), { code: 'limited' });
  now = 60000; limiter.consume(limits);
});
test('SQLite persists across reopen, isolates history, expires and deletes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vaxir-test-'));
  const path = join(dir, 'test.sqlite');
  let repo = new SqliteRepository(path);
  try {
    const settings = defaultSettings(readEnv({}));
    settings.enabled = false;
    settings.aiChannelId = '123456789012345678';
    settings.ai = {
      provider: 'custom', model: 'persistent-model', encryptedKey: 'encrypted-value',
      baseUrl: 'https://gateway.example/v1', apiFormat: 'responses',
    };
    settings.revision = 4;
    const c = { guildId: '1', channelId: '2', userId: '3' };
    await repo.saveSettings('1', settings);
    await repo.saveMessages(c, [{ role: 'user', content: 'hello' }], 100);
    repo.close(); repo = new SqliteRepository(path);
    assert.deepEqual(await repo.getSettings('1'), settings);
    assert.equal((await repo.getMessages(c, 0))[0]?.content, 'hello');
    assert.deepEqual(await repo.getMessages({ ...c, userId: '4' }, 0), []);
    assert.deepEqual(await repo.getMessages(c, 101), []);
    await repo.prune(101); assert.deepEqual(await repo.getMessages(c, 0), []);
    await repo.saveMessages(c, [{ role: 'user', content: 'again' }], 200);
    await repo.clearMessages(c); assert.deepEqual(await repo.getMessages(c, 0), []);
    await repo.deleteGuild('1'); assert.equal(await repo.getSettings('1'), null);
  } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('admin commands reject regular users before touching settings', async () => {
  const env = readEnv({}); const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  let reply: any;
  await admin.handle({ inGuild: () => true, isChatInputCommand: () => true, commandName: 'setup', memberPermissions: { has: () => false }, reply: async (value: any) => { reply = value; } } as any);
  assert.ok(reply.content.includes('ผู้ดูแล')); assert.equal(await repo.getSettings('1'), null);
  assert.equal(isAdmin(null), false);
  for (const command of commands.filter(c => ['setup', 'clear', 'server-plan'].includes(c.name))) {
    assert.equal(command.toJSON().default_member_permissions, PermissionFlagsBits.Administrator.toString());
  }
});
test('setup encrypts keys and status omits them', async () => {
  const env = readEnv({}); const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const admin = new AdminCommands(env, service, secrets);
  const replies: unknown[] = [];
  const base = { inGuild: () => true, guildId: '1', memberPermissions: { has: () => true }, deferReply: async () => {}, editReply: async (value: unknown) => { replies.push(value); } };
  const fields: Record<string, string> = { provider: 'gemini', model: 'test-model', key: 'a-secret-key', base: '' };
  await admin.handle({ ...base, isChatInputCommand: () => false, isModalSubmit: () => true, fields: { getTextInputValue: (id: string) => fields[id] } } as any);
  const stored = await repo.getSettings('1'); assert.ok(stored?.ai);
  assert.equal(secrets.decrypt(stored.ai.encryptedKey, '1'), 'a-secret-key');
  assert.ok(!JSON.stringify(stored).includes('a-secret-key'));
  await admin.handle({ ...base, memberPermissions: { has: () => false }, isChatInputCommand: () => true, commandName: 'status' } as any);
  assert.match(JSON.stringify(replies), /test-model/);
  for (const command of commands.filter(c => ['ask', 'status'].includes(c.name))) assert.equal(command.toJSON().default_member_permissions, undefined);
  assert.ok(!JSON.stringify(replies).includes('a-secret-key')); assert.ok(!JSON.stringify(replies).includes(stored.ai.encryptedKey));
});

test('setup saves and resets server personality instructions', async () => {
  const env = readEnv({}); const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  const base = { inGuild: () => true, guildId: '1', memberPermissions: { has: () => true }, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'setup', deferReply: async () => {}, editReply: async () => {} };
  await admin.handle({ ...base, options: { getSubcommand: () => 'instructions', getString: () => 'ตอบแบบโจรสลัด', getAttachment: () => null } } as any);
  assert.equal((await repo.getSettings('1'))?.instructions, 'ตอบแบบโจรสลัด');
  await admin.handle({ ...base, options: { getSubcommand: () => 'reset-instructions' } } as any);
  assert.equal((await repo.getSettings('1'))?.instructions, '');
});
