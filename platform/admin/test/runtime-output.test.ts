// The reason a failed local endpoint shows: the runtime's one-line fatal error
// when it printed one, else the last stderr lines.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startupFailure } from '../lib/runtime-output';

describe('startupFailure', () => {
  test('prefers the fatal line the runtime prints over the stack trace around it', () => {
    const lines = ['Error: boom', '    at x (file.js:1:1)', '{"fatal":"connect ECONNREFUSED 127.0.0.1:1"}', '}', 'Node.js v26.7.0'];
    assert.equal(startupFailure(lines), 'connect ECONNREFUSED 127.0.0.1:1');
  });

  test('falls back to the last lines, and says so when there is no output', () => {
    assert.equal(startupFailure(['a', 'b', 'c', 'd']), 'b | c | d');
    assert.equal(startupFailure([]), 'no output');
    assert.equal(startupFailure(['{"fatal":42}', 'x']), '{"fatal":42} | x', 'a non-string fatal is not trusted');
  });
});
