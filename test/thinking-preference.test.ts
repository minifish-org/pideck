import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultThinking, readProjectThinking, saveProjectThinking } from '../src/renderer/thinking-preference';

test('thinking defaults to medium and respects supported levels', () => {
  assert.equal(defaultThinking(['low', 'medium', 'high']), 'medium');
  assert.equal(defaultThinking(['off', 'medium']), 'medium');
  assert.equal(defaultThinking(['off']), 'off');
  assert.equal(defaultThinking(['low', 'high']), 'low');
  assert.equal(defaultThinking([]), 'off');
  assert.equal(defaultThinking(['low', 'medium', 'high'], 'high'), 'high');
  assert.equal(defaultThinking(['off', 'low', 'medium'], 'off'), 'off');
  assert.equal(defaultThinking(['off', 'low', 'medium'], 'low'), 'low');
  assert.equal(defaultThinking(['low', 'medium'], 'max'), 'medium');
  assert.equal(defaultThinking(['off'], 'high'), 'off');
});

test('project thinking persists independently and tolerates invalid or unavailable storage', () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    saveProjectThinking('one', 'high');
    saveProjectThinking('two', 'low');
    assert.equal(readProjectThinking('one'), 'high');
    assert.equal(readProjectThinking('two'), 'low');
    assert.equal(readProjectThinking('three'), undefined);
    values.set('pideck.thinking.v1/one', 'invalid');
    assert.equal(readProjectThinking('one'), undefined);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable'); } });
    assert.equal(readProjectThinking('one'), undefined);
    assert.doesNotThrow(() => saveProjectThinking('one', 'high'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
