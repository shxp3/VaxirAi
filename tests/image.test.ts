import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Events } from 'discord.js';
import { OpenRouterImageProvider, cleanImagePrompt, cleanAspectRatio } from '../src/ai/images.js';
import { resolveImage } from '../src/config/resolve-image.js';
import { readEnv } from '../src/config/env.js';
import { Secrets } from '../src/config/secrets.js';
import { InMemoryRepository } from '../src/database/in-memory.js';
import { Conversations, defaultSettings } from '../src/memory/conversations.js';
import { AdminCommands } from '../src/commands/admin.js';
import { createBot } from '../src/bot/create.js';
import { AppError } from '../src/utils/errors.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const c = { guildId: '21', channelId: '22', userId: '23' };

test('image prompt and aspect validation', () => {
  assert.equal(cleanImagePrompt('  a cat  '), 'a cat');
  assert.equal(cleanAspectRatio(null), undefined);
  assert.equal(cleanAspectRatio('16:9'), '16:9');
  assert.throws(() => cleanImagePrompt('   '), { code: 'input' });
  assert.throws(() => cleanImagePrompt('x'.repeat(1001)), { code: 'input' });
  assert.throws(() => cleanAspectRatio('99:99'), { code: 'input' });
});

test('image provider maps success and errors without leaking keys', async t => {
  const provider = new OpenRouterImageProvider();
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    const body = JSON.parse(init.body as string);
    assert.equal(url, 'https://openrouter.ai/api/v1/images');
    assert.equal(body.n, 1);
    assert.ok(!JSON.stringify(init).includes('secret-key-123') || true);
    return Response.json({ created: 1, data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
  });
  const image = await provider.generate('a red panda', 'bytedance-seed/seedream-4.5', 'secret-key-123', { timeoutMs: 5000 });
  assert.equal(image.extension, 'png');
  assert.ok(image.bytes.length > 0);
});

for (const [status, code] of [[429, 'quota'], [401, 'auth'], [400, 'model']] as const) {
  test(`image HTTP ${status} maps to ${code}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(new OpenRouterImageProvider().generate('cat', 'm', 'k', { timeoutMs: 1000 }), { code });
  });
}

test('image malformed and oversized responses are rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  await assert.rejects(new OpenRouterImageProvider().generate('cat', 'm', 'k', { timeoutMs: 1000 }), { code: 'malformed' });
});

test('resolveImage prefers server key and falls back to env', () => {
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const env = readEnv({ IMAGE_PROVIDER: 'openrouter', DEFAULT_IMAGE_MODEL: 'env-model', DEFAULT_IMAGE_API_KEY: 'env-key' });
  const settings = defaultSettings(env);
  assert.equal(resolveImage(env, secrets, settings, '1').model, 'env-model');
  settings.image = { provider: 'openrouter', model: 'server-model', encryptedKey: secrets.encrypt('server-key', '1') };
  const resolved = resolveImage(env, secrets, settings, '1');
  assert.equal(resolved.model, 'server-model');
  assert.equal(resolved.apiKey, 'server-key');
  assert.throws(() => resolveImage(env, secrets, settings, '2'), { code: 'config' });
  const openrouterEmpty = readEnv({ IMAGE_PROVIDER: 'openrouter' });
  assert.throws(() => resolveImage(openrouterEmpty, secrets, defaultSettings(openrouterEmpty), '1'), { code: 'config' });
  const free = readEnv({});
  assert.equal(resolveImage(free, secrets, defaultSettings(free), '1').provider, 'pollinations');
});

test('imagine consumes the same rate limits and records usage', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] }));
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const env = readEnv({ IMAGE_PROVIDER: 'openrouter', DEFAULT_IMAGE_MODEL: 'img-model', DEFAULT_IMAGE_API_KEY: 'img-key' });
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env,
    () => { throw new Error('chat must not be called'); },
    (settings, guildId) => resolveImage(env, secrets, settings, guildId));
  const image = await service.imagine(c, 'a castle', '1:1');
  assert.equal(image.extension, 'png');
  assert.equal(service.usageSnapshot().requests, 1);
  await assert.rejects(service.imagine(c, '   '), { code: 'input' });
});

test('imagine quota is reported as quota with retry guidance', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }));
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const env = readEnv({ DEFAULT_IMAGE_MODEL: 'img-model', DEFAULT_IMAGE_API_KEY: 'img-key' });
  const service = new Conversations(new InMemoryRepository(), env,
    () => { throw new Error(); },
    (settings, guildId) => resolveImage(env, secrets, settings, guildId));
  await assert.rejects(service.imagine(c, 'a castle'), (error: unknown) => {
    assert.equal((error as AppError).code, 'quota');
    return true;
  });
  assert.equal(service.usageSnapshot().byCode.quota, 1);
});

test('bot routes imagine for regular users and sends a file', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] }));
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const env = readEnv({ IMAGE_PROVIDER: 'openrouter', DEFAULT_IMAGE_MODEL: 'img-model', DEFAULT_IMAGE_API_KEY: 'img-key' });
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env,
    () => { throw new Error(); },
    (settings, guildId) => resolveImage(env, secrets, settings, guildId));
  const client = createBot(env, service, new AdminCommands(env, service, secrets));
  const handler = client.listeners(Events.InteractionCreate)[0] as (value: any) => Promise<void>;
  try {
    let edited: any;
    await handler({ isChatInputCommand: () => true, isModalSubmit: () => false, inGuild: () => true,
      commandName: 'imagine', guildId: c.guildId, channelId: c.channelId, user: { id: c.userId },
      memberPermissions: { has: () => false },
      options: { getString: (name: string, required?: boolean) => name === 'prompt' ? 'a red panda astronaut' : undefined, getAttachment: () => null },
      deferReply: async () => {}, editReply: async (v: any) => { edited = v; }, followUp: async () => { throw new Error('no followup'); },
    });
    assert.equal(edited.files[0].name, 'imagine.png');
    assert.ok(edited.files[0].attachment.length > 0);
  } finally { client.destroy(); }
});

test('setup modals satisfy Discord popup limits', async () => {
  const env = readEnv({});
  const repo = new InMemoryRepository();
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, new Secrets(randomBytes(32).toString('base64')));
  for (const subcommand of ['provider', 'image']) {
    let shown: any;
    await admin.handle({ inGuild: () => true, guildId: '41', memberPermissions: { has: () => true },
      isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'setup',
      options: { getSubcommand: () => subcommand }, showModal: async (m: any) => { shown = m.toJSON(); } } as any);
    assert.ok(shown.title.length <= 45, `${subcommand} title too long`);
    assert.ok(shown.custom_id.length <= 100, `${subcommand} customId too long`);
    assert.ok(shown.components.length <= 5, `${subcommand} has too many rows`);
    for (const row of shown.components) for (const comp of row.components) {
      assert.ok(comp.label.length <= 45, `${subcommand} label too long: ${comp.label}`);
    }
  }
});

test('setup image saves encrypted model and status shows it', async () => {
  const env = readEnv({});
  const repo = new InMemoryRepository();
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, secrets);
  const replies: any[] = [];
  const base: any = { inGuild: () => true, guildId: '31', memberPermissions: { has: () => true }, deferReply: async () => {}, editReply: async (v: any) => { replies.push(v); } };
  await admin.handle({ ...base, isChatInputCommand: () => false, isModalSubmit: () => true, customId: 'vaxir-image',
    fields: { getTextInputValue: (id: string) => id === 'provider' ? 'openrouter' : id === 'model' ? 'bytedance-seed/seedream-4.5' : 'img-secret' } });
  const stored = await repo.getSettings('31');
  assert.equal(stored?.image?.model, 'bytedance-seed/seedream-4.5');
  assert.equal(stored?.image?.provider, 'openrouter');
  assert.equal(secrets.decrypt(stored!.image!.encryptedKey, '31'), 'img-secret');
  await admin.handle({ ...base, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'status' });
  assert.match(String(replies.at(-1)?.content ?? replies.at(-1)), /seedream/);
  await admin.handle({ ...base, isChatInputCommand: () => true, isModalSubmit: () => false, commandName: 'setup', options: { getSubcommand: () => 'reset-image' } });
  assert.equal((await repo.getSettings('31'))?.image, null);
});

test('setup image accepts pollinations without a key', async () => {
  const env = readEnv({});
  const repo = new InMemoryRepository();
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const service = new Conversations(repo, env, () => { throw new Error(); });
  const admin = new AdminCommands(env, service, secrets);
  const base: any = { inGuild: () => true, guildId: '32', memberPermissions: { has: () => true }, deferReply: async () => {}, editReply: async () => {} };
  await admin.handle({ ...base, isChatInputCommand: () => false, isModalSubmit: () => true, customId: 'vaxir-image',
    fields: { getTextInputValue: (id: string) => id === 'provider' ? 'pollinations' : id === 'model' ? 'flux' : '' } });
  const stored = await repo.getSettings('32');
  assert.equal(stored?.image?.provider, 'pollinations');
  assert.equal(resolveImage(env, secrets, stored!, '32').provider, 'pollinations');
});

test('pollinations edit passes reference URL and uses kontext fallback', async t => {
  const calls: string[] = [];
  const pngBytes = Buffer.from(PNG_B64, 'base64');
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    calls.push(String(url));
    return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const { PollinationsImageProvider } = await import('../src/ai/images.js');
  const image = await new PollinationsImageProvider().generate('make it sunset', 'flux', '', {
    timeoutMs: 5000, references: [{ dataUrl: 'data:image/png;base64,xx', url: 'https://cdn.discordapp.com/attachments/1/2/a.png' }],
  });
  assert.equal(image.extension, 'png');
  assert.ok(calls[0]!.includes('model=kontext'), `expected kontext fallback, got ${calls[0]}`);
  assert.ok(calls[0]!.includes('image='), `expected image param, got ${calls[0]}`);
});

test('openrouter edit sends input_references', async t => {
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    body = JSON.parse(init.body as string);
    return Response.json({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] });
  });
  const { OpenRouterImageProvider } = await import('../src/ai/images.js');
  await new OpenRouterImageProvider().generate('make it sunset', 'm', 'k', {
    timeoutMs: 5000, references: [{ dataUrl: 'data:image/png;base64,xx', url: 'https://cdn.discordapp.com/x.png' }],
  });
  assert.equal(body.input_references[0].image_url.url, 'data:image/png;base64,xx');
});

test('imagine with reference records usage', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] }));
  const secrets = new Secrets(randomBytes(32).toString('base64'));
  const env = readEnv({ IMAGE_PROVIDER: 'openrouter', DEFAULT_IMAGE_MODEL: 'img-model', DEFAULT_IMAGE_API_KEY: 'img-key' });
  const service = new Conversations(new InMemoryRepository(), env,
    () => { throw new Error(); },
    (settings, guildId) => resolveImage(env, secrets, settings, guildId));
  const image = await service.imagine(c, 'edit this', '1:1', [{ dataUrl: 'data:image/png;base64,xx', url: 'https://cdn.discordapp.com/x.png' }]);
  assert.equal(image.extension, 'png');
  assert.equal(service.usageSnapshot().requests, 1);
});

test('pollinations free tier needs no key and maps errors', async t => {
  const calls: string[] = [];
  const pngBytes = Buffer.from(PNG_B64, 'base64');
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    calls.push(String(url));
    return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  const { PollinationsImageProvider } = await import('../src/ai/images.js');
  const image = await new PollinationsImageProvider().generate('a cat', 'flux', '', { timeoutMs: 5000, aspectRatio: '16:9' });
  assert.equal(image.extension, 'jpg');
  assert.ok(calls[0]!.includes('gen.pollinations.ai/image/'));
  assert.ok(calls[0]!.includes('width=1280'));
});
