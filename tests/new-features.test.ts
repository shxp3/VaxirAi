import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { ProviderRequestQueue, queueCooldownForConfig, sharedQueue } from '../src/ai/request-queue.js';
import { AppError } from '../src/utils/errors.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations } from '../src/memory/conversations.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { AdminCommands } from '../src/commands/admin.js';
import { createBot } from '../src/bot/create.js';
import type { Message } from '../src/ai/types.js';

const c = { guildId: '10', channelId: '20', userId: '30' };

function convoFixture(generate: (messages: Message[]) => Promise<string>) {
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', CONTEXT_MESSAGE_LIMIT: '10' });
  const service = new Conversations(repo, env, () => ({ provider: { generate }, config: env.defaultAI }));
  return { repo, env, service };
}

test('queue exposes cooldown for status without leaking keys', async () => {
  const queue = new ProviderRequestQueue();
  assert.equal(queue.cooldown('missing'), null);
  assert.equal(queue.activeCooldowns(), 0);
  await assert.rejects(queue.run('k1', 1000, 0, async () => { throw new AppError('quota', 60); }), { code: 'quota' });
  const cd = queue.cooldown('k1');
  assert.ok(cd && cd.code === 'quota' && cd.seconds >= 59 && cd.seconds <= 60);
  assert.equal(queue.activeCooldowns(), 1);
});

test('regenerate reuses last user prompt and replaces last answer', async () => {
  const calls: Message[][] = [];
  let n = 0;
  const { service, repo } = convoFixture(async messages => { calls.push(messages); return `answer-${++n}`; });
  await service.ask(c, 'first question');
  const retry = await service.regenerate(c);
  assert.equal(retry, 'answer-2');
  // Last call replays history without duplicating the user turn.
  assert.equal(calls[1]!.filter(m => m.role === 'user').length, 1);
  const stored = await repo.getMessages(c, 0);
  assert.equal(stored.length, 2);
  assert.equal(stored[1]?.content, 'answer-2');
  await assert.rejects(service.regenerate({ ...c, userId: 'nobody' }), { code: 'input' });
});

test('summarize does not append to history but counts usage', async () => {
  let calls = 0;
  const { service, repo } = convoFixture(async messages => {
    calls++;
    if (calls === 1) assert.equal(messages.length, 1);
    else assert.ok(messages.length >= 3);
    return 'summary text';
  });
  await service.ask(c, 'hello world');
  const summary = await service.summarize(c);
  assert.equal(summary, 'summary text');
  assert.equal((await repo.getMessages(c, 0)).length, 2);
  const snap = service.usageSnapshot();
  assert.equal(snap.requests, 2);
  assert.equal(snap.successes, 2);
});

test('usage tracks quota separately per guild', async () => {
  const { service } = convoFixture(async () => { throw new AppError('quota', 1); });
  await assert.rejects(service.ask(c, 'hi'));
  await assert.rejects(service.ask({ ...c, guildId: '11' }, 'hi'));
  const snap = service.usageSnapshot();
  assert.equal(snap.requests, 2);
  assert.equal(snap.byCode.quota, 2);
  assert.equal(snap.byGuild['10']?.quota, 1);
  assert.equal(snap.byGuild['11']?.requests, 1);
});

test('bot routes regenerate and summarize for regular users', async () => {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'ok' }, config: env.defaultAI }));
  await repo.saveMessages(c, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], Date.now());
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    for (const commandName of ['regenerate', 'summarize'] as const) {
      let edited: any;
      await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
        commandName, guildId: c.guildId, channelId: c.channelId, user: { id: c.userId },
        memberPermissions: { has: () => false },
        deferReply: async () => {}, editReply: async (v: any) => { edited = v; }, followUp: async () => { throw new Error('no followup expected'); },
      });
      assert.equal(edited.content, 'ok');
    }
  } finally { client.destroy(); }
});

test('setup validation rejects bad keys before saving', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'bad key' } }, { status: 401 }));
  const env = readEnv({});
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  const fields: Record<string, string> = { provider: 'groq', model: 'llama-test', key: 'bad-key', base: '', format: '' };
  await assert.rejects(admin.handle({ inGuild: () => true, guildId: '99', memberPermissions: { has: () => true },
    isChatInputCommand: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
    deferReply: async () => {}, editReply: async () => {} } as any), { code: 'auth' });
  assert.equal(await repo.getSettings('99'), null);
});

test('status shows cooldown and usage reports counters', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
  const env = readEnv({});
  const repo = new InMemoryRepository();
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const service = new Conversations(repo, env, () => ({ provider: { generate: async () => 'ok' }, config: env.defaultAI }));
  const admin = new AdminCommands(env, service, secrets);
  const replies: any[] = [];
  const base: any = { inGuild: () => true, guildId: '77', memberPermissions: { has: () => true }, deferReply: async () => {}, editReply: async (v: any) => { replies.push(v); } };
  await admin.handle({ ...base, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'status' });
  assert.match(String(replies[0]?.content ?? replies[0]), /Cooldown: none/);
  await admin.handle({ ...base, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'usage' });
  assert.match(String(replies[1]?.content ?? replies[1]), /Requests:/);
  // Shared queue helper never throws and never contains raw keys.
  assert.equal(queueCooldownForConfig({ provider: 'groq', model: 'x', apiKey: 'no-such-key-123' }), null);
  assert.ok(!String(sharedQueue.activeCooldowns()).includes('no-such-key'));
});
