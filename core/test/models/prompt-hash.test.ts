// Every saved handler records its generator's promptHash; a changed hash
// regenerates all of them in explore mode (§4.7). These pins make any change
// to prompt text, or to how a provider assembles it, a deliberate one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claude } from '../../src/models/claude/index.js';
import { groq } from '../../src/models/groq/index.js';

const OPTIONS = { apiKey: 'unused', model: 'any-model' };

test('the Claude generator prompt hash is pinned', () => {
  assert.equal(claude.generator(OPTIONS).promptHash, '313a77512d9f381c');
});

test('the Groq generator prompt hash is pinned', () => {
  assert.equal(groq.generator(OPTIONS).promptHash, 'b83cde5142c04958');
});

// Multi-source handlers record multiSourcePromptHash instead (MS3); the same rule applies.
test('the Claude multi-source prompt hash is pinned', () => {
  assert.equal(claude.generator(OPTIONS).multiSourcePromptHash, 'e8d58ce885f0a33f');
});

test('the Groq multi-source prompt hash is pinned', () => {
  assert.equal(groq.generator(OPTIONS).multiSourcePromptHash, '6855d4110b0b4bc5');
});
