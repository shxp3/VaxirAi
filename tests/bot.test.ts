import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { createBot } from '../src/bot/create.js';
import { AdminCommands } from '../src/commands/admin.js';
import { Secrets } from '../src/config/secrets.js';
import { readEnv } from '../src/config/env.js';
import { resolveAI } from '../src/config/resolve-ai.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations, defaultSettings } from '../src/memory/conversations.js';
import { AppError } from '../src/utils/errors.js';
function fixture(generate: () => Promise<string>) {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider: { generate }, config: env.defaultAI }));
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  return { client, service, repo };
}

test('regular users cannot clear memory or invoke admin commands', async () => {
  const { client, service } = fixture(async () => { throw new Error('unexpected AI call'); });
  service.clear = async () => { throw new Error('must not clear'); };
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    for (const commandName of ['clear', 'setup']) {
      let reply: any;
      await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
        commandName, memberPermissions: { has: () => false }, reply: async (p: any) => { reply = p; } });
      assert.match(reply.content, /ผู้ใช้ทั่วไปใช้ได้เฉพาะ/);
    }
  } finally { client.destroy(); }
});
test('ask defers before generation and splits replies with mentions disabled', async () => {
  let deferred = false;
  const { client } = fixture(async () => { assert.equal(deferred, true); return 'a'.repeat(4200); });
  const sent: any[] = [];
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'ask', guildId: '1', channelId: '2', user: { id: '3' }, options: { getString: () => 'hi', getAttachment: () => null },
      deferReply: async () => { deferred = true; }, editReply: async (value: any) => { sent.push(value); }, followUp: async (value: any) => { sent.push(value); },
    });
    assert.equal(sent.length, 3); assert.equal(sent.map(v => v.content).join(''), 'a'.repeat(4200));
    assert.ok(sent.every(v => v.content.length <= 2000 && v.allowedMentions.parse.length === 0));
  } finally { client.destroy(); }
});
test('provider errors produce a friendly deferred reply', async () => {
  const { client } = fixture(async () => { throw new AppError('quota', 5); });
  const sent: any[] = [];
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true, deferred: true,
      commandName: 'ask', guildId: '1', channelId: '2', user: { id: '3' }, options: { getString: () => 'hi', getAttachment: () => null },
      deferReply: async () => {}, editReply: async (value: any) => { sent.push(value); },
    });
    assert.equal(sent.length, 1); assert.ok(sent[0].includes('โควตา')); assert.ok(sent[0].includes('5'));
  } finally { client.destroy(); }
});
test('code answers are sent as files instead of inline code blocks', async () => {
  const { client } = fixture(async () => 'คำอธิบาย\n```python\nprint("hello")\n```');
  const sent: any[] = [];
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'ask', guildId: '1', channelId: '2', user: { id: '3' }, options: { getString: () => 'write code', getAttachment: () => null },
      deferReply: async () => {}, editReply: async (value: any) => { sent.push(value); }, followUp: async (value: any) => { sent.push(value); },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, 'คำอธิบาย');
    assert.equal(sent[0].files[0].name, 'code-1.py');
    assert.equal(sent[0].files[0].attachment.toString('utf8'), 'print("hello")\n');
  } finally { client.destroy(); }
});
test('database failure cannot cause unsolicited replies in ordinary channels', async () => {
  const { client, repo } = fixture(async () => 'ok');
  repo.getSettings = async () => { throw new Error('database failure'); };
  const handler = client.listeners(Events.MessageCreate)[0] as (value: any) => Promise<void>;
  let replies = 0;
  try {
    await handler({ guildId: '1', author: { bot: false }, webhookId: null, reply: async () => { replies++; } });
    assert.equal(replies, 0);
  } finally { client.destroy(); }
});
test('server provider overrides default and broken server keys never silently fall back', () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'default-key', DEFAULT_AI_MODEL: 'default-model' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const settings = defaultSettings(env);
  assert.equal(resolveAI(env, secrets, settings, '1').config.apiKey, 'default-key');
  settings.ai = { provider: 'groq', model: 'server-model', encryptedKey: secrets.encrypt('server-key', '1') };
  const resolved = resolveAI(env, secrets, settings, '1');
  assert.equal(resolved.config.provider, 'groq'); assert.equal(resolved.config.apiKey, 'server-key');
  assert.throws(() => resolveAI(env, secrets, settings, '2'), { code: 'config' });
});
