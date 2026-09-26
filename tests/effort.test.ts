import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  normalizeEffort, isEffortLevel, settingsForEffort,
  geminiThinkingLevel, chatReasoningEffort, messagesThinkingBudget,
} from '../src/ai/effort.js';
import { GeminiProvider } from '../src/ai/gemini.js';
import { OpenAICompatibleProvider } from '../src/ai/compatible.js';
import { ResponsesProvider } from '../src/ai/responses.js';
import { MessagesProvider } from '../src/ai/messages.js';
import { readEnv } from '../src/config/env.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations, defaultSettings, normalizeSettings } from '../src/memory/conversations.js';
import { AdminCommands } from '../src/commands/admin.js';
import { Secrets } from '../src/config/secrets.js';
import type { GenerationSettings } from '../src/ai/types.js';

const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test' });

test('effort names normalize, defaulting to medium', () => {
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('  Max '), 'max');
  assert.equal(normalizeEffort('junk'), 'medium');
  assert.equal(normalizeEffort(undefined), 'medium');
  assert.ok(isEffortLevel('light') && !isEffortLevel('ultra'));
  assert.equal(readEnv({ DEFAULT_EFFORT: 'high' }).defaultEffort, 'high');
  assert.equal(readEnv({ DEFAULT_EFFORT: 'junk' }).defaultEffort, 'medium');
});

test('effort scales tokens and timeout', () => {
  const light = settingsForEffort(env, 'light');
  assert.equal(light.maxOutputTokens, 256);
  assert.equal(light.timeoutMs, 30000);
  const medium = settingsForEffort(env, 'medium');
  assert.equal(medium.maxOutputTokens, env.maxOutputTokens);
  assert.equal(medium.timeoutMs, env.timeoutMs);
  const high = settingsForEffort(env, 'high');
  assert.equal(high.timeoutMs, Math.min(env.timeoutMs * 2, 300000));
  assert.ok(high.timeoutMs > medium.timeoutMs);
  const max = settingsForEffort(env, 'max');
  assert.equal(max.maxOutputTokens, 8192);
  assert.ok(max.timeoutMs >= 180000 && max.timeoutMs <= 600000);
  // Per-server timeout override scales high/max.
  const custom = settingsForEffort(env, 'high', 120000);
  assert.equal(custom.timeoutMs, 240000);
  // Invalid stored timeout falls back to env base.
  assert.equal(settingsForEffort(env, 'medium', NaN).timeoutMs, env.timeoutMs);
});

test('reasoning params are omitted on medium and sent otherwise', () => {
  assert.equal(geminiThinkingLevel('medium'), undefined);
  assert.equal(geminiThinkingLevel(undefined), undefined);
  assert.equal(geminiThinkingLevel('light'), 'MINIMAL');
  assert.equal(geminiThinkingLevel('max'), 'HIGH');
  assert.equal(chatReasoningEffort('medium'), undefined);
  assert.equal(chatReasoningEffort('light'), 'minimal');
  assert.equal(chatReasoningEffort('high'), 'high');
  assert.equal(messagesThinkingBudget('medium'), undefined);
  assert.equal(messagesThinkingBudget('light'), undefined);
  assert.equal(messagesThinkingBudget('high'), 1024);
  assert.equal(messagesThinkingBudget('max'), 4096);
});

test('Gemini sends thinkingLevel only for non-medium effort', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  });
  const config = { provider: 'gemini' as const, model: 'm', apiKey: 'k' };
  const base: GenerationSettings = { timeoutMs: 5000, maxOutputTokens: 128, maxResponseChars: 1000 };
  await new GeminiProvider().generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'medium' });
  assert.equal(bodies[0].generationConfig.thinkingConfig, undefined);
  await new GeminiProvider().generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'high' });
  assert.equal(bodies[1].generationConfig.thinkingLevel ?? bodies[1].generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
});

test('chat/responses send reasoning effort only for non-medium effort', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  const config = { provider: 'groq' as const, model: 'm', apiKey: 'k' };
  const base: GenerationSettings = { timeoutMs: 5000, maxOutputTokens: 128, maxResponseChars: 1000 };
  const chat = new OpenAICompatibleProvider('https://api.groq.com/openai/v1');
  await chat.generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'medium' });
  assert.equal(bodies[0].reasoning_effort, undefined);
  await chat.generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'light' });
  assert.equal(bodies[1].reasoning_effort, 'minimal');
});

test('responses API wraps effort in a reasoning object', async t => {
  let body: any;
  const provider = new ResponsesProvider('https://gateway.example/v1', async (_url, init) => {
    body = JSON.parse(init.body as string);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] });
  });
  const config = { provider: 'custom' as const, model: 'm', apiKey: 'k', baseUrl: 'https://gateway.example/v1' };
  const base: GenerationSettings = { timeoutMs: 5000, maxOutputTokens: 128, maxResponseChars: 1000 };
  await provider.generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'high' });
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('messages enables thinking only for high/max with room above budget', async t => {
  const bodies: any[] = [];
  const provider = new MessagesProvider('https://gateway.example/v1', async (_url, init) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  });
  const config = { provider: 'custom' as const, model: 'm', apiKey: 'k', baseUrl: 'https://gateway.example/v1' };
  const base: GenerationSettings = { timeoutMs: 5000, maxOutputTokens: 256, maxResponseChars: 1000 };
  await provider.generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'medium' });
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[0].max_tokens, 256);
  await provider.generate([{ role: 'user', content: 'hi' }], config, { ...base, effort: 'max' });
  assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.ok(bodies[1].max_tokens > 4096);
});

test('old stored settings normalize to medium effort', () => {
  const fresh = defaultSettings(env);
  assert.equal(fresh.effort, 'medium');
  const legacy = normalizeSettings(env, { ...fresh, effort: 'ultra' as any, timeoutMs: 5 as any });
  assert.equal(legacy.effort, 'medium');
  assert.equal(legacy.timeoutMs, undefined);
});

test('ask uses effort-scaled generation settings', async () => {
  const repo = new InMemoryRepository();
  const seen: GenerationSettings[] = [];
  const service = new Conversations(repo, env, () => ({
    provider: { generate: async (_m, _c, s) => { seen.push(s); return 'ok'; } },
    config: env.defaultAI,
  }));
  const c = { guildId: '1', channelId: '2', userId: '3' };
  await service.ask(c, 'hello');
  assert.equal(seen[0]?.effort, 'medium');
  assert.equal(seen[0]?.timeoutMs, env.timeoutMs);
  const settings = await repo.getSettings('1') ?? defaultSettings(env);
  settings.effort = 'max';
  settings.timeoutMs = 120000;
  await repo.saveSettings('1', settings);
  await service.ask({ ...c, channelId: 'other' }, 'hello again');
  assert.equal(seen[1]?.effort, 'max');
  assert.equal(seen[1]?.maxOutputTokens, 8192);
  assert.ok((seen[1]?.timeoutMs ?? 0) > env.timeoutMs);
});

test('admin effort/timeout subcommands save without wiping memory', async () => {
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  const c = { guildId: '9', channelId: '8', userId: '7' };
  await repo.saveMessages(c, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], Date.now());
  const replies: unknown[] = [];
  const base: any = { inGuild: () => true, guildId: '9', memberPermissions: { has: () => true }, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'setup', deferReply: async () => {}, editReply: async (v: unknown) => { replies.push(v); } };
  await admin.handle({ ...base, options: { getSubcommand: () => 'effort', getString: () => 'high' } });
  assert.equal((await repo.getSettings('9'))?.effort, 'high');
  await admin.handle({ ...base, options: { getSubcommand: () => 'timeout', getInteger: () => 120 } });
  assert.equal((await repo.getSettings('9'))?.timeoutMs, 120000);
  await admin.handle({ ...base, options: { getSubcommand: () => 'reset-timeout' } });
  assert.equal((await repo.getSettings('9'))?.timeoutMs, undefined);
  await assert.rejects(admin.handle({ ...base, options: { getSubcommand: () => 'effort', getString: () => 'ultra' } }), { code: 'input' });
  // Memory survives effort/timeout-only changes.
  assert.equal((await repo.getMessages(c, 0)).length, 2);
  assert.ok(String(replies[0]).includes('effort'));
});
