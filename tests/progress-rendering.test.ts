import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { DiscordStreamRenderer, type StreamPayload } from '../src/utils/discord-stream.js';
import { prepareDiscordResponse } from '../src/utils/discord-response.js';
import { RequestMetrics } from '../src/utils/request-metrics.js';
import { Conversations } from '../src/memory/conversations.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { readEnv } from '../src/config/env.js';
import { AppError } from '../src/utils/errors.js';
import { createBot } from '../src/bot/create.js';
import { AdminCommands } from '../src/commands/admin.js';
import { Secrets } from '../src/config/secrets.js';
import type { AIProvider, GenerationEvent, GenerationOptions } from '../src/ai/types.js';

const c = { guildId: '1', channelId: '2', userId: '3' };
const started: GenerationEvent = { type: 'progress', stage: 'request_started' };
function rendererFixture(interval = 2500) {
  const ack: string[] = [], edits: StreamPayload[] = [], sends: StreamPayload[] = [];
  const metrics = new RequestMetrics();
  const renderer = new DiscordStreamRenderer({ acknowledge: async content => { ack.push(content); },
    edit: async p => { edits.push(p); return { id: 'initial' }; },
    send: async p => { sends.push(p); return { id: `extra-${sends.length}` }; } }, interval, 80, metrics);
  return { renderer, ack, edits, sends, metrics };
}
function fixture(provider: AIProvider, extra = {}) {
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', MAX_CONCURRENT_REQUESTS: '4' });
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => ({ provider, config: env.defaultAI, ...extra }));
  return { env, repo, service };
}
test('renderer throttles hundreds of deltas, avoids unchanged edits and flushes final without duplicates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { renderer, ack, edits, sends } = rendererFixture();
  await renderer.onEvent(started);
  for (let i = 0; i < 1000; i++) await renderer.onEvent({ type: 'text_delta', text: 'x' });
  assert.equal(ack.length, 1); assert.equal(edits.length, 0);
  t.mock.timers.tick(2499); await turn(); assert.equal(edits.length, 0);
  t.mock.timers.tick(1); await turn(); assert.equal(edits.length, 1); assert.equal(edits[0]!.content, 'x'.repeat(1000));
  t.mock.timers.tick(5000); await turn(); assert.equal(edits.length, 1);
  await renderer.finish([{ content: 'x'.repeat(1000), components: [{ button: 'regenerate' }] }]);
  assert.equal(sends.length, 0); assert.equal(edits.at(-1)!.content, 'x'.repeat(1000));
  assert.equal(edits.at(-1)!.components!.length, 1);
  await renderer.onEvent({ type: 'text_delta', text: 'stale' }); t.mock.timers.tick(10000); await turn();
  assert.equal(edits.length, 2);
  assert.ok(edits.every(p => p.allowedMentions!.parse.length === 0 && p.allowedMentions!.repliedUser === false));
});
test('renderer bounds previews and only splits complete long answers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { renderer, edits, sends } = rendererFixture();
  await renderer.onEvent(started);
  const text = '🌏'.repeat(2300);
  await renderer.onEvent({ type: 'text_delta', text }); t.mock.timers.tick(2500); await turn();
  assert.ok(edits[0]!.content!.length <= 2000); assert.equal(sends.length, 0);
  const ids = await renderer.finish(prepareDiscordResponse(text));
  assert.equal(ids.length, 3);
  assert.equal([edits.at(-1)!, ...sends].map(p => p.content).join(''), text);
  assert.ok(sends.every(p => p.content!.length <= 2000));
});
test('code fences are withheld from previews and complete fenced code becomes a file once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { renderer, edits } = rendererFixture();
  await renderer.onEvent(started);
  const initial = 'Explanation\n```typescript\nconst x = ';
  await renderer.onEvent({ type: 'text_delta', text: initial }); t.mock.timers.tick(2500); await turn();
  assert.equal(edits[0]!.files, undefined); assert.ok(!edits[0]!.content!.includes('const x'));
  const text = initial + '1;\n```';
  await renderer.onEvent({ type: 'text_delta', text: '1;\n```' });
  await renderer.finish(prepareDiscordResponse(text));
  assert.equal(edits.at(-1)!.content, 'Explanation');
  assert.equal(edits.at(-1)!.files![0]!.name, 'code-1.ts');
  assert.equal(edits.at(-1)!.files![0]!.attachment.toString(), 'const x = 1;\n');
});
test('slow Discord edits never accumulate a backlog and final waits for the pending edit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edits: StreamPayload[] = [];
  const renderer = new DiscordStreamRenderer({ acknowledge: async () => {}, edit: async p => { edits.push(p); if (edits.length === 1) await gate; }, send: async () => {} }, 2500, 1);
  await renderer.onEvent(started); await renderer.onEvent({ type: 'text_delta', text: 'one' });
  t.mock.timers.tick(2500); await turn(); assert.equal(edits.length, 1);
  for (let i = 0; i < 500; i++) await renderer.onEvent({ type: 'text_delta', text: 'x' });
  t.mock.timers.tick(20000); await turn(); assert.equal(edits.length, 1);
  const finished = renderer.finish([{ content: 'final' }]); await turn(); assert.equal(edits.length, 1);
  release(); await finished; assert.equal(edits.length, 2); assert.equal(edits[1]!.content, 'final');
});
test('partial failure is visibly incomplete with no files or regenerate success button', async () => {
  const { renderer, edits } = rendererFixture();
  await renderer.onEvent(started); await renderer.onEvent({ type: 'text_delta', text: 'Partial answer' });
  await renderer.fail(new AppError('timeout'));
  assert.match(edits[0]!.content!, /Partial answer/); assert.match(edits[0]!.content!, /ยังไม่สมบูรณ์/);
  assert.equal(edits[0]!.files, undefined); assert.deepEqual(edits[0]!.components, []);
});
test('20-second first-output delay acknowledges immediately and retains a real working status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { renderer, ack, edits, metrics } = rendererFixture();
  const { service } = fixture({ generate: async (_messages, _config, _settings, options) => {
    assert.equal(ack.length, 1);
    await new Promise<void>(resolve => setTimeout(resolve, 20000));
    await options?.onEvent?.({ type: 'text_delta', text: 'slow answer' });
    return 'slow answer';
  } });
  const pending = service.ask(c, 'question', [], { onEvent: renderer.onEvent, metrics });
  await turn(); assert.equal(ack.length, 1);
  t.mock.timers.tick(2500); await turn(); assert.match(edits.at(-1)!.content!, /กำลังสร้างคำตอบ/);
  t.mock.timers.tick(17499); await turn(); assert.ok(!edits.some(p => p.content?.includes('slow answer')));
  t.mock.timers.tick(1); const answer = await pending; await renderer.finish(prepareDiscordResponse(answer));
  assert.equal(edits.at(-1)!.content, 'slow answer');
  assert.equal(metrics.snapshot().firstOutputMs, 20000);
});
test('search stages reflect actual search completion before generation begins', async () => {
  const events: GenerationEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service } = fixture({ generate: async () => { assert.ok(events.some(e => e.type === 'progress' && e.stage === 'search_completed')); return 'answer'; } }, {
    grounder: { shouldSearch: () => true, search: async (_input: string, options: GenerationOptions) => {
      assert.ok(options.signal); await gate; return { context: 'evidence', sources: [{ index: 1, title: 'Source', url: 'https://example.com' }] };
    } },
  });
  const pending = service.ask(c, 'latest', [], { onEvent: e => { events.push(e); } }); await turn();
  const stages = () => events.filter(e => e.type === 'progress').map(e => e.stage);
  assert.deepEqual(stages(), ['request_started', 'search_started']);
  release(); await pending;
  assert.ok(stages().indexOf('search_completed') < stages().indexOf('generation_started'));
});
test('cancelled partial requests keep memory unchanged, release locks and ignore late callbacks', async () => {
  let options!: GenerationOptions;
  const { service, repo } = fixture({ generate: async (_messages, _config, _settings, opts) => {
    options = opts!; await opts!.onEvent!({ type: 'text_delta', text: 'partial' });
    return new Promise<string>(() => {});
  } });
  await repo.saveMessages(c, [{ role: 'user', content: 'old prompt' }, { role: 'assistant', content: 'old answer' }], Date.now());
  const events: GenerationEvent[] = [];
  const pending = service.regenerate(c, { onEvent: e => { events.push(e); } }); await turn();
  assert.equal(service.cancel(c), true); await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(service.activeCount, 0); assert.equal(options.signal!.aborted, true);
  assert.deepEqual((await repo.getMessages(c, 0)).map(m => m.content), ['old prompt', 'old answer']);
  await assert.rejects(Promise.resolve(options.onEvent!({ type: 'text_delta', text: 'late' })), { code: 'cancelled' });
  assert.ok(!JSON.stringify(events).includes('late'));
});
test('search shares the total deadline and timeout never calls the provider or stores memory', async () => {
  let called = 0, signal: AbortSignal | undefined;
  const { service, repo } = fixture({ generate: async () => { called++; return 'answer'; } }, {
    grounder: { shouldSearch: () => true, search: async (_input: string, options: GenerationOptions) => { signal = options.signal; return new Promise(() => {}); } },
  });
  service.effortSettings = () => ({ timeoutMs: 25, maxOutputTokens: 100, maxResponseChars: 1000 });
  await assert.rejects(service.ask(c, 'latest'), { code: 'timeout' });
  assert.equal(called, 0); assert.equal(signal!.aborted, true); assert.equal(service.activeCount, 0);
  assert.deepEqual(await repo.getMessages(c, 0), []); assert.equal(service.usageSnapshot().byCode.timeout, 1);
});
test('concurrent users and guilds have isolated progress, output and memory', async () => {
  const { service, repo } = fixture({ generate: async (messages, _config, _settings, opts) => {
    const text = messages.at(-1)!.content; await turn(); await opts?.onEvent?.({ type: 'text_delta', text }); return text;
  } });
  const others = [c, { ...c, userId: '4' }, { ...c, guildId: '5' }];
  const events = others.map(() => [] as GenerationEvent[]);
  assert.deepEqual(await Promise.all(others.map((conversation, index) => service.ask(conversation, `question-${index}`, [], { onEvent: e => { events[index]!.push(e); } }))), ['question-0', 'question-1', 'question-2']);
  for (let i = 0; i < others.length; i++) {
    assert.deepEqual(events[i]!.filter(e => e.type === 'text_delta').map(e => e.text), [`question-${i}`]);
    assert.equal((await repo.getMessages(others[i]!, 0)).at(-1)!.content, `question-${i}`);
  }
});
test('rejected and disabled requests do not publish an acknowledgment', async () => {
  const { service, repo } = fixture({ generate: async () => 'unused' });
  const events: GenerationEvent[] = [];
  const options = { onEvent: (e: GenerationEvent) => { events.push(e); } };
  await assert.rejects(service.ask(c, '', [], options), { code: 'input' });
  const settings = await service.settings(c.guildId); settings.enabled = false; await repo.saveSettings(c.guildId, settings);
  await assert.rejects(service.ask(c, 'question', [], options), { code: 'disabled' });
  settings.enabled = true; settings.aiChannelId = 'other'; await repo.saveSettings(c.guildId, settings);
  await assert.rejects(service.ask(c, 'question', [], options), { code: 'wrong_ai_channel' });
  assert.deepEqual(events, []);
});
test('regular message acknowledges before provider generation, reuses it and preserves regenerate', async () => {
  const replies: StreamPayload[] = [], edits: StreamPayload[] = [];
  const { service, env } = fixture({ generate: async (_messages, _config, _settings, opts) => {
    assert.equal(replies.length, 1); assert.match(replies[0]!.content!, /เตรียมข้อมูล/);
    await opts?.onEvent?.({ type: 'text_delta', text: 'answer' }); return 'answer';
  } });
  const client = createBot(env, service, new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64'))));
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  const message = { id: 'user-message', guildId: c.guildId, channelId: c.channelId, author: { id: c.userId, bot: false }, webhookId: null,
    content: 'question', attachments: new Map(), mentions: { users: { has: () => true } }, channel: { sendTyping: async () => {} },
    reply: async (payload: StreamPayload) => { replies.push(payload); return { id: 'initial', edit: async (p: StreamPayload) => { edits.push(p); } }; },
  };
  try {
    await (client.listeners(Events.MessageCreate)[0] as (message: unknown) => Promise<void>)(message);
    assert.equal(replies.length, 1); assert.equal(edits.length, 1); assert.equal(edits[0]!.content, 'answer');
    assert.equal(edits[0]!.components!.length, 1); assert.deepEqual(edits[0]!.allowedMentions!.parse, []);
  } finally { client.destroy(); }
});
test('metrics contain operational timings only, with no prompts, keys, answers or user IDs', () => {
  const metrics = new RequestMetrics();
  metrics.note(started); metrics.acknowledged(); metrics.end('timeout');
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.outcome, 'timed_out'); assert.equal(snapshot.discordEdits, 0); assert.ok(snapshot.acknowledgmentMs! >= 0);
  assert.ok(!JSON.stringify(snapshot).includes('prompt')); assert.ok(!JSON.stringify(snapshot).includes('apiKey'));
});
test('edited user messages stream into a temporary replacement and commit one updated turn', async () => {
  const replies: StreamPayload[] = [], edits: StreamPayload[] = [], deleted: string[] = [];
  let calls = 0;
  const { service, repo, env } = fixture({ generate: async (_messages, _config, _settings, options) => {
    const text = `answer-${++calls}`;
    await options?.onEvent?.({ type: 'text_delta', text }); return text;
  } });
  const client = createBot(env, service, new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64'))));
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  const channel = { sendTyping: async () => {}, messages: { fetch: async (id: string) => ({ delete: async () => { deleted.push(id); } }) } };
  const message = { id: 'user-message', guildId: c.guildId, channelId: c.channelId, author: { id: c.userId, bot: false }, webhookId: null,
    content: 'question', attachments: new Map(), mentions: { users: { has: () => true } }, channel,
    reply: async (payload: StreamPayload) => { replies.push(payload); const id = `reply-${replies.length}`; return { id, edit: async (p: StreamPayload) => { edits.push(p); } }; },
  };
  try {
    await (client.listeners(Events.MessageCreate)[0] as (message: unknown) => Promise<void>)(message);
    assert.deepEqual(deleted, []);
    await (client.listeners(Events.MessageUpdate)[0] as (old: unknown, next: unknown) => Promise<void>)({ content: 'question', attachments: new Map() }, { ...message, content: 'edited question' });
    assert.equal(replies.length, 2); assert.equal(edits.at(-1)!.content, 'answer-2'); assert.deepEqual(deleted, ['reply-1']);
    assert.deepEqual((await repo.getMessages(c, 0)).map(m => m.content), ['edited question', 'answer-2']);
    assert.equal(edits.at(-1)!.components!.length, 1);
  } finally { client.destroy(); }
});
test('failed regeneration keeps the previous Discord answer and memory intact', async () => {
  const { service, repo, env } = fixture({ generate: async (_messages, _config, _settings, options) => {
    await options?.onEvent?.({ type: 'text_delta', text: 'partial replacement' }); throw new AppError('timeout');
  } });
  await repo.saveMessages(c, [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'previous' }], Date.now());
  const client = createBot(env, service, new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64'))));
  const edits: StreamPayload[] = [], deleted: string[] = [];
  try {
    await (client.listeners(Events.InteractionCreate)[0] as (interaction: unknown) => Promise<void>)({
      isButton: () => true, isChatInputCommand: () => false, customId: 'vaxir-regenerate', inGuild: () => true,
      guildId: c.guildId, channelId: c.channelId, user: { id: c.userId }, message: { id: 'previous-answer' },
      channel: { messages: { fetch: async (id: string) => ({ delete: async () => { deleted.push(id); } }) } },
      deferReply: async () => {}, editReply: async (p: StreamPayload) => { edits.push(p); return { id: 'replacement' }; }, followUp: async () => {},
    });
    assert.deepEqual(deleted, []); assert.match(edits.at(-1)!.content!, /ยังไม่สมบูรณ์/);
    assert.equal((await repo.getMessages(c, 0)).at(-1)!.content, 'previous');
  } finally { client.destroy(); }
});
test('a slow older Discord delivery cannot delete or replace tracking for a newer accepted answer', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service, repo, env } = fixture({ generate: async () => `answer-${++calls}` });
  await repo.saveMessages(c, [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'previous' }], Date.now());
  const client = createBot(env, service, new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64'))));
  const deleted: string[] = [];
  const channel = { messages: { fetch: async (id: string) => ({ delete: async () => { deleted.push(id); } }) } };
  const handler = client.listeners(Events.InteractionCreate)[0] as (interaction: unknown) => Promise<void>;
  const button = (id: string, editReply: (payload: StreamPayload) => Promise<{ id: string }>) => ({
    isButton: () => true, isChatInputCommand: () => false, customId: 'vaxir-regenerate', inGuild: () => true,
    guildId: c.guildId, channelId: c.channelId, user: { id: c.userId }, message: { id }, channel,
    deferReply: async () => {}, editReply, followUp: async () => {},
  });
  try {
    const older = handler(button('previous-answer', async () => { await gate; return { id: 'older-answer' }; }));
    await turn(); assert.equal(service.activeCount, 0);
    await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'ask', guildId: c.guildId, channelId: c.channelId, user: { id: c.userId }, channel,
      options: { getString: () => 'new question', getAttachment: () => null }, deferReply: async () => {},
      editReply: async () => ({ id: 'newer-answer' }), followUp: async () => {},
    });
    release(); await older; assert.equal(deleted.length, 0);
    await handler(button('newer-answer', async () => ({ id: 'latest-answer' })));
    assert.ok(deleted.includes('newer-answer')); assert.ok(!deleted.includes('older-answer'));
  } finally { release(); client.destroy(); }
});
test('prompt preparation follows acknowledgment and reuses the single loaded history', async () => {
  let acknowledged = false, reads = 0;
  const { service, repo } = fixture({ generate: async messages => { assert.equal(messages.at(-1)!.content, 'context: question'); return 'answer'; } });
  const getMessages = repo.getMessages.bind(repo);
  repo.getMessages = async (...args) => { reads++; return getMessages(...args); };
  await service.ask(c, 'question', [], { onEvent: e => { if (e.type === 'progress' && e.stage === 'request_started') acknowledged = true; },
    preparePrompt: async (prompt, history, signal) => { assert.equal(acknowledged, true); assert.deepEqual(history, []); assert.equal(signal.aborted, false); return `context: ${prompt}`; },
  });
  assert.equal(reads, 1);
});
test('settings revision changes stop subsequent stream output and preserve previous memory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let options!: GenerationOptions;
  const { service, repo } = fixture({ generate: async (_messages, _config, _settings, opts) => { options = opts!; return new Promise<string>(() => {}); } });
  const events: GenerationEvent[] = [];
  const pending = service.ask(c, 'question', [], { onEvent: e => { events.push(e); } }); await turn();
  const settings = await service.settings(c.guildId); settings.revision++; await repo.saveSettings(c.guildId, settings);
  t.mock.timers.tick(1001);
  await assert.rejects(Promise.resolve(options.onEvent!({ type: 'text_delta', text: 'stale' })), { code: 'cancelled' });
  await assert.rejects(pending, { code: 'cancelled' });
  assert.deepEqual(await repo.getMessages(c, 0), []); assert.ok(!JSON.stringify(events).includes('stale'));
});
test('unchanged final summary does not resend the last preview', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { renderer, edits } = rendererFixture();
  await renderer.onEvent(started); await renderer.onEvent({ type: 'text_delta', text: 'Summary answer' });
  t.mock.timers.tick(2500); await turn();
  const ids = await renderer.finish([{ content: 'Summary answer' }]);
  assert.deepEqual(ids, ['initial']); assert.equal(edits.length, 1);
});
test('failed notification callbacks cannot mask quota errors or leave conversation locks stuck', async () => {
  const { service } = fixture({ generate: async () => { throw new AppError('quota', 12); } });
  await assert.rejects(service.ask(c, 'question', [], { onEvent: event => {
    if (event.type === 'progress' && event.stage === 'failed') throw new Error('notification failure');
  } }), { code: 'quota', retryAfter: 12 });
  assert.equal(service.activeCount, 0); assert.equal(service.usageSnapshot().byCode.quota, 1);
});
