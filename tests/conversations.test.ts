import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations, defaultSettings } from '../src/memory/conversations.js';
import { readEnv } from '../src/config/env.js';
import { shouldRespond } from '../src/bot/routing.js';
import { splitDiscordText } from '../src/utils/discord-text.js';
import { userError } from '../src/utils/errors.js';
import type { Message } from '../src/ai/types.js';
const c = { guildId: '1', channelId: '2', userId: '3' };
function fixture(generate = async (_messages: Message[]) => 'answer') {
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', CONTEXT_MESSAGE_LIMIT: '4' });
  return { repo, service: new Conversations(repo, env, () => ({ provider: { generate }, config: env.defaultAI })) };
}
test('history is bounded, isolated by server/channel/user, and clearable', async () => {
  const requests: Message[][] = [];
  const { service, repo } = fixture(async messages => { requests.push(messages); return 'answer'; });
  await service.ask(c, 'one'); await service.ask(c, 'two'); await service.ask(c, 'three');
  assert.equal((await repo.getMessages(c, 0)).length, 4); assert.equal(requests[1]!.length, 3);
  for (const other of [{ ...c, guildId: '4' }, { ...c, channelId: '5' }, { ...c, userId: '6' }]) {
    await service.ask(other, 'isolated'); assert.equal(requests.at(-1)!.length, 1);
  }
  await service.clear(c); assert.deepEqual(await repo.getMessages(c, 0), []);
});
test('failed requests do not poison history and release locks', async () => {
  const { service, repo } = fixture(async () => { throw new Error('provider failed'); });
  await assert.rejects(service.ask(c, 'hi')); assert.deepEqual(await repo.getMessages(c, 0), []); assert.equal(service.activeCount, 0);
});
test('concurrent asks and clear cannot race an active conversation', async () => {
  let finish!: (value: string) => void;
  const { service } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.ask(c, 'hi');
  await assert.rejects(service.ask(c, 'again'), { code: 'busy' }); await assert.rejects(service.clear(c), { code: 'busy' });
  finish('ok'); await pending;
});
test('message routing responds only to explicit mentions or configured channel', () => {
  const input = { guildId: '1', authorIsBot: false, webhookId: null, mentioned: false, channelId: '2', aiChannelId: null };
  assert.equal(shouldRespond(input), false); assert.equal(shouldRespond({ ...input, mentioned: true }), true);
  assert.equal(shouldRespond({ ...input, aiChannelId: '2' }), true);
  assert.equal(shouldRespond({ ...input, mentioned: true, authorIsBot: true }), false);
  assert.equal(shouldRespond({ ...input, mentioned: true, webhookId: '9' }), false);
  assert.equal(shouldRespond({ ...input, mentioned: true, guildId: null }), false);
});
test('a configured AI channel rejects AI requests elsewhere and points users to that channel', async () => {
  let calls = 0;
  const { service, repo } = fixture(async () => { calls++; return 'answer'; });
  const settings = await service.settings(c.guildId);
  settings.aiChannelId = '123456789012345678';
  await repo.saveSettings(c.guildId, settings);
  await assert.rejects(service.ask(c, 'hello'), error => {
    assert.match(userError(error), /<#123456789012345678>/);
    return (error as any)?.code === 'wrong_ai_channel';
  });
  assert.equal(calls, 0);
  await service.ask({ ...c, channelId: settings.aiChannelId }, 'hello');
  assert.equal(calls, 1);
});
test('long Unicode responses fit Discord limits without losing characters', () => {
  const input = '😀'.repeat(3000); const chunks = splitDiscordText(input);
  assert.equal(chunks.join(''), input); assert.ok(chunks.every(c => c.length <= 2000 && !c.endsWith('\ud83d')));
});
test('long fenced code remains valid Markdown in every Discord chunk', () => {
  const input = `คำอธิบาย\n\n\`\`\`javascript\n${'console.log("hello");\n'.repeat(250)}\`\`\``;
  const chunks = splitDiscordText(input);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 2000));
  for (const chunk of chunks) assert.equal((chunk.match(/\`\`\`/g) ?? []).length % 2, 0);
  assert.ok(chunks.slice(1).every(chunk => chunk.startsWith('```javascript\n')));
});
test('plain fenced code without a language is safely closed and reopened', () => {
  const chunks = splitDiscordText(`\`\`\`\n${'x'.repeat(4000)}\n\`\`\``);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 2000 && (chunk.match(/\`\`\`/g) ?? []).length % 2 === 0));
});
test('settings changes during generation discard stale output and history', async () => {
  let finish!: (value: string) => void;
  const { service, repo } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.ask(c, 'hi');
  await new Promise(resolve => setImmediate(resolve));
  const settings = await service.settings(c.guildId); settings.revision++; settings.enabled = false;
  await repo.saveSettings(c.guildId, settings);
  finish('stale'); await assert.rejects(pending, { code: 'busy' });
  assert.deepEqual(await repo.getMessages(c, 0), []);
  await assert.rejects(service.ask(c, 'hi'), { code: 'disabled' });
});
test('invalid input and user rate limit prevent provider calls', async () => {
  let calls = 0; const { service } = fixture(async () => { calls++; return 'ok'; });
  await assert.rejects(service.ask(c, '  '), { code: 'input' });
  await assert.rejects(service.ask(c, 'x'.repeat(service.env.maxPromptChars + 1)), { code: 'input' });
  for (let n = 0; n < 5; n++) await service.ask(c, 'hi');
  await assert.rejects(service.ask({ ...c, channelId: 'other' }, 'hi'), { code: 'limited' });
  assert.equal(calls, 5);
});
test('auto search grounds current questions without storing retrieved web content in memory', async () => {
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', CONTEXT_MESSAGE_LIMIT: '4', BRAVE_SEARCH_API_KEY: 'search-key' });
  const settings = defaultSettings(env);
  await repo.saveSettings(c.guildId, settings);
  const requests: Message[][] = [];
  const service = new Conversations(repo, env, () => ({
    provider: { generate: async messages => { requests.push(messages); return 'answer [1]'; } }, config: env.defaultAI,
    grounder: { shouldSearch: query => query.includes('ล่าสุด'), search: async () => ({ context: '<web_grounding>[1] current fact</web_grounding>', sources: [{ index: 1, title: 'News', url: 'https://example.com/news' }] }) },
  }));
  await service.ask(c, 'ข่าวล่าสุด');
  assert.match(requests[0]![0]!.content, /web_grounding/);
  assert.deepEqual((await repo.getMessages(c, 0)).map(message => message.content), ['ข่าวล่าสุด', 'answer [1]']);
  await service.ask(c, 'สวัสดี');
  assert.doesNotMatch(requests[1]!.at(-1)!.content, /web_grounding/);
});
test('source links are appended only when the user asks for them', async () => {
  const repo = new InMemoryRepository();
  const env = readEnv({ DEFAULT_AI_API_KEY: 'test', DEFAULT_AI_MODEL: 'test', BRAVE_SEARCH_API_KEY: 'search-key' });
  const settings = defaultSettings(env); await repo.saveSettings(c.guildId, settings);
  const service = new Conversations(repo, env, () => ({
    provider: { generate: async () => 'answer [1]' }, config: env.defaultAI,
    grounder: { shouldSearch: () => true, search: async () => ({ context: '<web_grounding>fact</web_grounding>', sources: [{ index: 1, title: 'News', url: 'https://example.com/news' }] }) },
  }));
  const answer = await service.ask(c, 'ขอแหล่งข้อมูลข่าวล่าสุด');
  assert.match(answer, /แหล่งข้อมูลจากการค้นเว็บ/);
  assert.match(answer, /https:\/\/example\.com\/news/);
});
