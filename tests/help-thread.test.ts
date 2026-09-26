import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { shouldRespond } from '../src/bot/routing.js';
import { assertAIChannel } from '../src/memory/conversations.js';
import { HELP_TEXT } from '../src/commands/help.js';
import {
  combinePromptWithContext,
  fetchReplyContext,
  fetchThreadSeed,
  getThreadParentId,
} from '../src/bot/thread-context.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { AdminCommands } from '../src/commands/admin.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations } from '../src/memory/conversations.js';
import { createBot } from '../src/bot/create.js';

test('help text documents every user command', () => {
  for (const cmd of ['/ask', '/imagine', '/regenerate', '/summarize', '/clear', '/status', '/help', '/usage', '/setup', '/server-plan']) {
    assert.ok(HELP_TEXT.includes(cmd), `missing ${cmd}`);
  }
});

test('threads under the AI channel respond, unrelated channels do not', () => {
  const base = { guildId: '1', authorIsBot: false, webhookId: null, mentioned: false, channelId: 'thread-1', aiChannelId: 'ai-1' };
  assert.equal(shouldRespond({ ...base, threadParentId: 'ai-1' }), true);
  assert.equal(shouldRespond({ ...base, threadParentId: 'other' }), false);
  assert.equal(shouldRespond({ ...base, threadParentId: null }), false);
});

test('AI channel guard accepts thread children', () => {
  const settings = { enabled: true, aiChannelId: 'ai-1', userRateLimit: 5, contextMessageLimit: 20, ai: null, revision: 0 } as never;
  assert.doesNotThrow(() => assertAIChannel(settings, 'thread-1', 'ai-1'));
  assert.throws(() => assertAIChannel(settings, 'thread-1', 'other'), { code: 'wrong_ai_channel' });
});

test('thread parent resolves from parentId or parent object', () => {
  assert.equal(getThreadParentId({ parentId: 'p1' }), 'p1');
  assert.equal(getThreadParentId({ parent: { id: 'p2' } }), 'p2');
  assert.equal(getThreadParentId({}), null);
  assert.equal(getThreadParentId(null), null);
});

test('reply context quotes the referenced message', async () => {
  const ctx = await fetchReplyContext({
    reference: { messageId: 'm1' },
    channel: { messages: { fetch: async (id: string) => ({ content: 'original question', author: { username: 'alice' }, attachments: { size: 0 } }) } },
  });
  assert.ok(ctx?.includes('original question'));
  assert.equal(await fetchReplyContext({}), null);
});

test('thread seed is null outside threads and combines safely', async () => {
  assert.equal(await fetchThreadSeed({}), null);
  assert.equal(await fetchThreadSeed(null), null);
  assert.equal(combinePromptWithContext('hi', [null, undefined, ''], 100), 'hi');
  const combined = combinePromptWithContext('hi', ['[ตอบกลับ bob: hello]'], 10000);
  assert.ok(combined.includes('คำถามปัจจุบัน: hi') && combined.includes('hello'));
  assert.ok(combinePromptWithContext('x'.repeat(10), ['y'.repeat(100)], 20).length <= 20 + 200);
});

test('bot routes /help to regular users as ephemeral text', async () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'unused' }, config: env.defaultAI }));
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    let replied: any;
    await handler({
      isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'help', memberPermissions: { has: () => false },
      reply: async (p: any) => { replied = p; },
    });
    assert.ok(String(replied.content).includes('/ask'));
  } finally { client.destroy(); }
});
