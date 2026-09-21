import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations } from '../src/memory/conversations.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { AdminCommands } from '../src/commands/admin.js';
import { createBot } from '../src/bot/create.js';
import type { Message } from '../src/ai/types.js';

const c = { guildId: '500000000000000001', channelId: '600000000000000001', userId: '700000000000000001' };

test('editLast replaces last turn instead of appending', async () => {
  const calls: Message[][] = [];
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', CONTEXT_MESSAGE_LIMIT: '10' });
  const service = new Conversations(repo, env, () => ({
    provider: { generate: async (messages: Message[]) => { calls.push(messages); return `echo:${messages[messages.length - 1]?.content}`; } },
    config: env.defaultAI,
  }));
  await service.ask(c, 'first question');
  await service.ask(c, 'second question');
  const edited = await service.editLast(c, 'second question edited');
  assert.match(edited, /second question edited/);
  const stored = await repo.getMessages(c, 0);
  assert.equal(stored.length, 4);
  assert.equal(stored[2]?.content, 'second question edited');
  const lastCall = calls[calls.length - 1]!;
  assert.equal(lastCall.filter(m => m.role === 'user').length, 2);
  assert.equal(lastCall[lastCall.length - 1]?.content, 'second question edited');
});

test('editLast on empty history behaves like ask', async () => {
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'ok' }, config: env.defaultAI }));
  const out = await service.editLast(c, 'hello');
  assert.equal(out, 'ok');
  assert.equal((await repo.getMessages(c, 0)).length, 2);
});

test('regenerate button deletes old reply and sends new one with button', async () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'fresh answer' }, config: env.defaultAI }));
  await repo.saveMessages(c, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'old' }], Date.now());
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    const deleted: string[] = [];
    let edited: any;
    await handler({
      isButton: () => true, isChatInputCommand: () => false, isModalSubmit: () => false,
      customId: `vaxir-regenerate:${c.userId}`, inGuild: () => true,
      guildId: c.guildId, channelId: c.channelId, user: { id: c.userId },
      message: { id: 'old-bot-msg' },
      channel: { messages: { fetch: async (id: string) => ({ delete: async () => { deleted.push(id); } }) } },
      deferReply: async () => {}, editReply: async (v: any) => { edited = v; return { id: 'new-bot-msg' }; },
      followUp: async () => { throw new Error('no followup'); }, reply: async () => { throw new Error('no reply'); },
    });
    assert.equal(edited.content, 'fresh answer');
    assert.ok(Array.isArray(edited.components) && edited.components.length === 1);
    assert.ok(deleted.includes('old-bot-msg'));
  } finally { client.destroy(); }
});

test('regenerate button rejects other users without deleting', async () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  let calls = 0;
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => { calls++; return 'x'; } }, config: env.defaultAI }));
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    let replied: any;
    await handler({
      isButton: () => true, isChatInputCommand: () => false, isModalSubmit: () => false,
      customId: `vaxir-regenerate:${c.userId}`, inGuild: () => true,
      guildId: c.guildId, channelId: c.channelId, user: { id: '999999999999999999' },
      message: { id: 'old-bot-msg' },
      channel: { messages: { fetch: async () => { throw new Error('should not delete'); } } },
      deferReply: async () => { throw new Error('should not defer'); },
      editReply: async () => { throw new Error('should not edit'); },
      followUp: async () => { throw new Error('no followup'); },
      reply: async (v: any) => { replied = v; },
    });
    assert.equal(calls, 0);
    assert.ok(String(replied.content).includes(c.userId));
  } finally { client.destroy(); }
});

test('ask reply includes owner-scoped regenerate button', async () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'hello' }, config: env.defaultAI }));
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    let edited: any;
    await handler({
      isButton: () => false, isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'ask', guildId: c.guildId, channelId: c.channelId, user: { id: c.userId },
      memberPermissions: { has: () => false },
      options: { getString: () => 'hi', getAttachment: () => null },
      deferReply: async () => {}, editReply: async (v: any) => { edited = v; }, followUp: async () => { throw new Error('no followup'); },
    });
    assert.equal(edited.content, 'hello');
    assert.ok(Array.isArray(edited.components) && edited.components.length === 1);
    const customId = edited.components[0].toJSON().components[0].custom_id as string;
    assert.ok(customId.startsWith('vaxir-regenerate:'));
    assert.ok(customId.includes(c.userId));
  } finally { client.destroy(); }
});
