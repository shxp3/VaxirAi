import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendReply } from '../src/ai/friend-reply.js';

test('friend joke requires an explicit target and matching topic', () => {
  for (const target of ['<@842420149314650122>', '<@!842420149314650122>', '842420149314650122']) {
    assert.match(friendReply(`${target} เป็นเกย์รึป่าว`)!, /เรื่องรสนิยมให้เจ้าตัวตอบเอง/);
  }
  assert.ok(friendReply('Is <@842420149314650122> gay?'));
  for (const prompt of ['คนนี้เป็นเกย์รึป่าว', '<@123456789012345678> เป็นเกย์ไหม', '842420149314650122 สวัสดี', '1842420149314650122 gay', '8424201493146501220 gay']) {
    assert.equal(friendReply(prompt), null);
  }
});
