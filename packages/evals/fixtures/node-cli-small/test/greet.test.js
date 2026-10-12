import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';
import { formatDate } from '../src/time.js';

test('greets by name', () => assert.equal(greet('Ann'), 'Hello, Ann!'));
test('formats dates', () => assert.equal(formatDate(new Date(2026, 0, 15)), '2026-1-15'));
