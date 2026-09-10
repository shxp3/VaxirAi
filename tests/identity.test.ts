import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityInstruction } from '../src/ai/identity.js';

test('identity names the bot creator and current configured model without secrets', () => {
  const instruction = identityInstruction({ provider: 'custom', model: 'gpt-5.6-luna', apiKey: 'super-secret', baseUrl: 'https://secret-gateway.example/v1' });
  assert.match(instruction, /Vaxir AI was created by shxp3/);
  assert.match(instruction, /provider "custom"/);
  assert.match(instruction, /model ID "gpt-5\.6-luna"/);
  assert.doesNotMatch(instruction, /super-secret|secret-gateway/);
});
