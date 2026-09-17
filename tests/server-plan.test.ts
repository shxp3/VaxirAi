import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOperations, validateServerOperations, validateTargets, preview, ServerPlans } from '../src/commands/server-plan.js';
import { readEnv } from '../src/config/env.js';
import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
const channels = [{ id: '1', name: 'general', type: 0, parent: '2', permissions: '' }, { id: '2', name: 'Community', type: 4, parent: null, permissions: '' }];

test('inline category/channel overwrites are validated and visible before acceptance', () => {
  const state = { channels: [], roles: [{ id: 'g', name: '@everyone', position: 0, managed: false, permissions: '0' }] };
  const category = { action: 'create', type: 'category', name: 'server', ref: 'server', permissionOverwrites: [{ roleId: 'g', allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'] }] };
  const ops = validateServerOperations([category], state, []);
  assert.deepEqual((ops[0] as any).permissionOverwrites, category.permissionOverwrites);
  assert.match(preview(ops, state), /@everyone: allow ViewChannel, ReadMessageHistory; deny SendMessages, CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads/);
  for (const overwrite of [
    { roleRef: 'later', allow: ['SendMessages'] },
    { roleId: 'missing', deny: ['SendMessages'] },
    { roleId: 'g', allow: ['SendMessages'], deny: ['SendMessages'] },
    { roleId: 'g', allow: ['Administrator'] },
    { roleId: 'g', allow: ['UnknownPermission'] },
  ]) assert.throws(() => validateServerOperations([{ ...category, permissionOverwrites: [overwrite] }], state, []));
  assert.throws(() => validateServerOperations([{ ...category, permissionOverwrites: [category.permissionOverwrites[0], category.permissionOverwrites[0]] }], state, []));
});

test('permission-only plans preflight ManageRoles before any mutation', async () => {
  const state = { channels, roles: [{ id: 'g', name: '@everyone', position: 0, managed: false, permissions: '0' }] };
  const ops = validateServerOperations([{ action: 'set_channel_role_permissions', id: '1', roleId: 'g', deny: ['SendMessages'] }], state, []);
  await assert.rejects(validateTargets({ id: 'g' } as any, { permissions: { has: (bit: bigint) => bit !== P.ManageRoles } } as any, ops, state), /ManageRoles/);
});

test('accept creates read-only children, media exception, forum slowmode and voice limits', async () => {
  const plans = new ServerPlans(readEnv({}), { settings: async () => ({ aiChannelId: null }) } as any, {} as any);
  const everyone = { id: 'g', name: '@everyone', position: 0, managed: false, permissions: { bitfield: 0n } };
  const before = { channels: [], roles: [{ ...everyone, permissions: '0' }] };
  const operations = validateServerOperations([
    { action: 'create_role', name: 'media', ref: 'media', permissions: [] },
    { action: 'create', name: 'server', type: 'category', ref: 'server', permissionOverwrites: [{ roleId: 'g', allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'] }] },
    ...['announcement', 'update', 'support'].map(name => ({ action: 'create', name, type: 'text', parentRef: 'server' })),
    { action: 'create', name: 'public', type: 'category', ref: 'public', permissionOverwrites: [{ roleId: 'g', allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages'], deny: [] }] },
    { action: 'create', name: 'media', type: 'text', parentRef: 'public', slowmodeSeconds: 10, permissionOverwrites: [{ roleId: 'g', allow: [], deny: ['SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'] }, { roleRef: 'media', allow: ['SendMessages'], deny: [] }] },
    ...['general', 'profiles', 'suggestion'].map(name => ({ action: 'create', name, type: name === 'suggestion' ? 'forum' : 'text', parentRef: 'public', slowmodeSeconds: 10 })),
    { action: 'create', name: 'voice chat', type: 'category', ref: 'voice' },
    ...[1, 2, 3].map(n => ({ action: 'create', name: `VOICE CHAT ${n}`, type: 'voice', parentRef: 'voice', userLimit: 20 })),
  ], before, []);
  (plans as any).drafts.set('g', { token: 't', owner: 'u', snapshot: before, expires: Date.now() + 60000, operations });
  const cache = new Map<string, any>(); const created: any[] = []; const replies: any[] = [];
  const guild = {
    id: 'g', ownerId: 'owner',
    roles: { fetch: async () => new Map([['g', everyone]]), create: async () => ({ id: 'media-role' }) },
    members: { fetchMe: async () => ({ id: 'bot', permissions: { has: () => true }, roles: { highest: { position: 100 } } }) },
    channels: { cache, fetch: async (id?: string) => id ? cache.get(id) : cache, create: async (options: any) => {
      created.push(options);
      const channel = { id: `channel-${created.length}`, permissionOverwrites: { cache: new Map((options.permissionOverwrites ?? []).map((p: any) => [p.id, { ...p, allow: { bitfield: p.allow }, deny: { bitfield: p.deny } }])) } };
      cache.set(channel.id, channel); return channel;
    } },
  };
  await plans.handle({ isChatInputCommand: () => false, isButton: () => true, guild, memberPermissions: { has: () => true }, user: { id: 'u' }, channelId: 'log', customId: 'plan:accept:t', deferReply: async () => {}, editReply: async (p: any) => replies.push(p), followUp: async () => {} } as any);
  assert.equal(created.length, 13);
  const category = created.find(c => c.name === 'server');
  for (const name of ['announcement', 'update', 'support']) assert.deepEqual(created.find(c => c.name === name).permissionOverwrites, category.permissionOverwrites);
  const media = created.find(c => c.name === 'media');
  const mediaEveryone = media.permissionOverwrites.find((p: any) => p.id === 'g');
  assert.equal(mediaEveryone.allow & P.SendMessages, 0n);
  assert.equal(mediaEveryone.allow & P.ReadMessageHistory, P.ReadMessageHistory);
  assert.equal(mediaEveryone.deny & P.SendMessages, P.SendMessages);
  assert.equal(media.permissionOverwrites.find((p: any) => p.id === 'media-role').allow, P.SendMessages);
  assert.equal(created.find(c => c.name === 'public').permissionOverwrites[0].allow & P.SendMessages, P.SendMessages);
  for (const name of ['general', 'media', 'profiles', 'suggestion']) assert.equal(created.find(c => c.name === name).rateLimitPerUser, 10);
  assert.equal(created.find(c => c.name === 'suggestion').defaultThreadRateLimitPerUser, 10);
  for (const n of [1, 2, 3]) assert.equal(created.find(c => c.name === `VOICE CHAT ${n}`).userLimit, 20);
  assert.match(replies[0], /ครบ 14/);
});

test('plans accept 100 AI operations and reject 101', () => {
  const operations = Array.from({ length: 100 }, (_, index) => ({ action: 'create', name: `channel-${index}`, type: 'text', parent: null }));
  assert.equal(validateOperations(operations, channels, []).length, 100);
  assert.throws(() => validateOperations([...operations, { action: 'create', name: 'extra', type: 'text', parent: null }], channels, []), /1–100/);
});

test('bulk reset expands exact deletable channels and roles in a safe order', () => {
  const state = {
    channels: [
      { id: 'child', name: 'general', type: 0, parent: 'category', permissions: '' },
      { id: 'category', name: 'old', type: 4, parent: null, permissions: '' },
      { id: 'protected', name: 'bot', type: 0, parent: 'kept-category', permissions: '' },
      { id: 'kept-category', name: 'bot area', type: 4, parent: null, permissions: '' },
    ],
    roles: [
      { id: 'everyone', name: '@everyone', position: 0, managed: false, permissions: '0' },
      { id: 'managed', name: 'Bot', position: 3, managed: true, permissions: '0' },
      { id: 'old-role', name: 'Old', position: 2, managed: false, permissions: '0' },
    ],
  };
  const ops = validateServerOperations([{ action: 'delete_all_channels' }, { action: 'delete_all_roles' }], state, ['protected']);
  assert.deepEqual(ops.map(op => op.action), ['delete', 'delete', 'delete_role']);
  assert.deepEqual(ops.map((op: any) => op.id ?? op.roleId), ['child', 'category', 'old-role']);
  assert.match(preview(ops, state), /ลบ #general[\s\S]*ลบ #old[\s\S]*ลบ @Old/);
});

test('nonempty categories may be deleted only after their children', () => {
  assert.doesNotThrow(() => validateOperations([{ action: 'delete', id: '1' }, { action: 'delete', id: '2' }], channels, []));
  assert.throws(() => validateOperations([{ action: 'delete', id: '2' }, { action: 'delete', id: '1' }], channels, []), /ช่องย่อยก่อน/);
});

test('new channels can reference categories created earlier in the same plan', () => {
  const state = { channels, roles: [{ id: '123456789012345', name: 'Member', position: 1, managed: false, permissions: '0' }] };
  const ops = validateServerOperations([
    { action: 'create', name: 'SERVER', type: 'category', ref: 'server', parent: null },
    { action: 'create', name: 'announcement', type: 'text', ref: 'announcement', parentRef: 'server' },
    { action: 'create', name: 'suggestion', type: 'forum', ref: 'suggestion', parentRef: 'server', slowmodeSeconds: 10 },
    { action: 'create', name: 'VOICE CHAT 1', type: 'voice', ref: 'voice1', parentRef: 'server', userLimit: 20 },
    { action: 'set_channel_role_permissions', channelRef: 'announcement', roleId: '123456789012345', allow: ['ViewChannel'], deny: ['SendMessages'] },
  ], state, []);
  const report = preview(ops, state);
  assert.match(report, /announcement → #SERVER/);
  assert.match(report, /forum: suggestion → #SERVER — slowmode 10 วินาที/);
  assert.match(report, /voice: VOICE CHAT 1 → #SERVER — จำกัด 20 คน/);
  assert.doesNotMatch(report, /announcement → ไม่มีหมวดหมู่/);
  assert.throws(() => validateServerOperations([
    { action: 'create', name: 'announcement', type: 'text', parentRef: 'server' },
    { action: 'create', name: 'SERVER', type: 'category', ref: 'server', parent: null },
  ], state, []));
  assert.throws(() => validateServerOperations([{ action: 'create', name: 'bad', type: 'voice', slowmodeSeconds: 10 }], state, []), /slowmodeSeconds/);
  assert.throws(() => validateServerOperations([{ action: 'create', name: 'bad', type: 'text', userLimit: 20 }], state, []), /userLimit/);
});

test('channel overrides allow everyone role while member assignment still rejects it', async () => {
  const everyone = { id: 'guild', name: '@everyone', position: 0, managed: false, permissions: '0' };
  const state = { channels, roles: [everyone] };
  const overwrite = validateServerOperations([{ action: 'set_channel_role_permissions', id: '1', roleId: 'guild', allow: ['ViewChannel'], deny: ['SendMessages'] }], state, []);
  const me = { id: 'bot', permissions: { has: () => true }, roles: { highest: { position: 10 } } };
  await assert.doesNotReject(validateTargets({ id: 'guild', ownerId: 'owner' } as any, me as any, overwrite, state));
  const assignment = validateServerOperations([{ action: 'assign_role', memberId: '223456789012345', roleId: 'guild' }], state, []);
  await assert.rejects(validateTargets({ id: 'guild', ownerId: 'owner' } as any, me as any, assignment, state), /Role เป้าหมาย/);
});

for (const failSecond of [false, true]) test(`accept publishes accurate public summary, partial=${failSecond}`, async () => {
  const plans = new ServerPlans(readEnv({}), { settings: async () => ({ aiChannelId: null }) } as any, {} as any);
  const channelState = channels.map(c => ({ ...c, permissions: '[]' }));
  const before = { channels: channelState, roles: [] };
  const cache = new Map(channelState.map(c => [c.id, { ...c, parentId: c.parent, permissionOverwrites: { cache: new Map() }, permissionsFor: () => ({ has: () => true }) }]));
  const roleCache = new Map();
  let edits = 0;
  const publicReplies: any[] = [];
  const privateReplies: string[] = [];
  (plans as any).drafts.set('g', { token: 't', owner: 'u', snapshot: before, expires: Date.now() + 60000, operations: [{ action: 'rename', id: '1', name: 'new-chat' }, { action: 'rename', id: '2', name: 'new-category' }] });
  const i = { isChatInputCommand: () => false, isButton: () => true, guild: { id: 'g', ownerId: 'owner', channels: { cache, fetch: async () => cache, edit: async () => { edits++; if (failSecond && edits === 2) throw new Error('denied'); } }, roles: { fetch: async () => roleCache }, members: { fetchMe: async () => ({ id: 'bot', permissions: { has: () => true }, roles: { highest: { position: 100 } } }) } }, memberPermissions: { has: () => true }, user: { id: 'u' }, channelId: 'log', customId: 'plan:accept:t', deferReply: async () => {}, editReply: async (p: string) => privateReplies.push(p), followUp: async (p: any) => publicReplies.push(p) };
  await plans.handle(i as any);
  assert.equal(edits, 2);
  assert.equal(publicReplies.length, 1);
  assert.deepEqual(publicReplies[0].flags, []);
  assert.deepEqual(publicReplies[0].allowedMentions, { parse: [], users: ['u'] });
  assert.match(publicReplies[0].content, /<@u>/);
  assert.match(publicReplies[0].content, /new-chat/);
  if (failSecond) assert.match(publicReplies[0].content, /1\/2[\s\S]*ยังไม่สำเร็จ[\s\S]*new-category/);
  else assert.match(publicReplies[0].content, /ครบ 2/);
  await plans.handle(i as any);
  assert.equal(edits, 2);
  assert.equal(publicReplies.length, 1);
});
test('role and moderation plans validate safe references and timeout bounds', () => {
  const state = { channels, roles: [{ id: '123456789012345', name: 'Member', position: 1, managed: false, permissions: '0' }] };
  const ops = validateServerOperations([
    { action: 'create_role', name: 'VIP', ref: 'vip', permissions: ['ViewChannel', 'SendMessages'] },
    { action: 'set_channel_role_permissions', id: '1', roleRef: 'vip', allow: ['ViewChannel'], deny: ['SendMessages'] },
    { action: 'assign_role', memberId: '223456789012345', roleRef: 'vip' },
    { action: 'remove_role', memberId: '223456789012345', roleId: '123456789012345' },
    { action: 'timeout', memberId: '323456789012345', durationMinutes: 60 },
    { action: 'kick', memberId: '423456789012345', reason: 'spam' },
    { action: 'ban', memberId: '523456789012345' },
  ], state, []);
  assert.match(preview(ops, state), /สร้าง Role:[\s\S]*ตั้งสิทธิ์[\s\S]*มอบ[\s\S]*Timeout[\s\S]*เตะ[\s\S]*แบน/);
  assert.throws(() => validateServerOperations([{ action: 'timeout', memberId: '323456789012345', durationMinutes: 40321 }], state, []));
  assert.throws(() => validateServerOperations([{ action: 'assign_role', memberId: '223456789012345', roleId: '999999999999999' }], state, []));
  assert.throws(() => validateServerOperations([{ action: 'assign_role', memberId: '223456789012345', roleRef: 'vip' }, { action: 'create_role', name: 'VIP', ref: 'vip' }], state, []));
  assert.throws(() => validateServerOperations([{ action: 'create_role', name: 'VIP', ref: 'vip', permissions: ['UnknownPermission'] }], state, []));
  assert.throws(() => validateServerOperations([{ action: 'set_channel_role_permissions', id: '1', roleId: '123456789012345', allow: ['ViewChannel'], deny: ['ViewChannel'] }], state, []));
  const deletion = validateServerOperations([{ action: 'delete_role', roleId: '123456789012345' }], state, []);
  assert.match(preview(deletion, state), /ลบ @Member/);
  assert.throws(() => validateServerOperations([{ action: 'delete_role', roleId: 'missing' }], state, []));
});
test('plan rejects protected deletion, nonempty categories and arbitrary actions', () => {
  assert.throws(() => validateOperations([{ action: 'delete', id: '1' }], channels, ['1']));
  assert.throws(() => validateOperations([{ action: 'delete', id: '2' }], channels, []));
  assert.throws(() => validateOperations([{ action: 'ban', id: '1' }], channels, []));
  assert.throws(() => validateOperations([{ action: 'create', name: 'test', type: 'text', parent: 'missing' }], channels, []));
  assert.throws(() => validateOperations([{ action: 'delete', id: '1' }, { action: 'rename', id: '1', name: 'new' }], channels, []));
});
test('preview describes exact rename and destructive deletion', () => {
  const ops = validateOperations([{ action: 'rename', id: '1', name: 'chat' }], channels, []);
  assert.match(preview(ops, channels), /general.*chat/);
  assert.doesNotMatch(preview(ops, channels), /\(1\)/);
  assert.match(preview([{ action: 'delete', id: '1' }], channels), /กู้คืนไม่ได้/);
});
test('unauthorized users and stale buttons cannot reach guild mutations', async () => {
  const plans = new ServerPlans(readEnv({}), {} as any, {} as any);
  const replies: string[] = [];
  const base = { isChatInputCommand: () => false, isButton: () => true, guild: { id: 'g' }, user: { id: 'u' }, customId: 'plan:accept:stale', reply: async (p: any) => replies.push(p.content), deferReply: async () => {}, editReply: async (p: string) => replies.push(p) };
  await plans.handle({ ...base, memberPermissions: { has: () => false } } as any);
  await plans.handle({ ...base, memberPermissions: { has: () => true } } as any);
  assert.match(replies[0]!, /เฉพาะผู้ดูแล/);
  assert.match(replies[1]!, /หมดอายุ/);
});
