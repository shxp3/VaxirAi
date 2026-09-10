import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDiscordResponse } from '../src/utils/discord-response.js';

test('fenced code becomes a named Discord file while explanations remain text', () => {
  const parts = prepareDiscordResponse('ตัวอย่าง Java:\n\n```java\npublic class HelloWorld {}\n```\n\nเรียกด้วย main');
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.content, 'ตัวอย่าง Java:\n\nเรียกด้วย main');
  assert.equal(parts[0]!.files?.[0]?.name, 'code-1.java');
  assert.equal(parts[0]!.files?.[0]?.attachment.toString('utf8'), 'public class HelloWorld {}\n');
  assert.doesNotMatch(parts[0]!.content!, /```|public class/);
});

test('multiple languages get safe unique extensions and at most ten files per message', () => {
  const blocks = Array.from({ length: 12 }, (_, index) => `\`\`\`${index === 0 ? 'typescript' : index === 1 ? 'c++' : 'unknown!?'}\ncode ${index}\n\`\`\``).join('\n');
  const parts = prepareDiscordResponse(blocks);
  assert.equal(parts[0]!.files?.length, 10);
  assert.equal(parts[1]!.files?.length, 2);
  assert.equal(parts[0]!.files?.[0]?.name, 'code-1.ts');
  assert.equal(parts[0]!.files?.[1]?.name, 'code-2.cpp');
  assert.equal(parts[0]!.files?.[2]?.name, 'code-3.unknown');
});

test('ordinary answers keep using Discord text chunks without files', () => {
  const parts = prepareDiscordResponse('a'.repeat(4200));
  assert.equal(parts.length, 3);
  assert.equal(parts.map(part => part.content).join(''), 'a'.repeat(4200));
  assert.ok(parts.every(part => !part.files));
});
