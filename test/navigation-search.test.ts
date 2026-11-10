import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSessions } from '../src/renderer/session-search';
import type { Project, Session } from '../src/shared/api';

const projects: Project[] = [
  { id: 'first', name: 'Frontend', directory: '/first', createdAt: 1 },
  { id: 'other', name: '后端 Backend', directory: '/other', createdAt: 2 },
];
const session = (id: string, projectId: string, title: string, updatedAt: number, parentSessionId?: string): Session =>
  ({ id, projectId, title, updatedAt, createdAt: 1, parentSessionId });
const lists = {
  first: [session('root', 'first', 'Login flow', 1), session('branch', 'first', 'Retry LOGIN', 5, 'root')],
  other: [session('other-root', 'other', '修复登录验证', 9), session('other-task', 'other', 'Database', 2)],
};

test('session search includes every project and native branch, ordered by recency without mutating lists', () => {
  assert.deepEqual(searchSessions(projects, lists, '').map(result => result.session.id), ['other-root', 'branch', 'other-task', 'root']);
  assert.equal(lists.first[0]!.id, 'root');
  assert.deepEqual(searchSessions(projects, lists, 'login').map(result => result.session.id), ['branch', 'root']);
});

test('session search normalizes Unicode and case, matches Chinese and combines title/project terms', () => {
  assert.deepEqual(searchSessions(projects, lists, '  ＬＯＧＩＮ  frontend ').map(result => result.session.id), ['branch', 'root']);
  assert.deepEqual(searchSessions(projects, lists, '后端 登录').map(result => result.session.id), ['other-root']);
  assert.deepEqual(searchSessions(projects, lists, 'backend').map(result => result.session.id), ['other-root', 'other-task']);
  assert.deepEqual(searchSessions(projects, lists, 'frontend database'), []);
});

test('session search excludes removed projects and mismatched project ownership, tolerates unloaded lists', () => {
  assert.deepEqual(searchSessions(projects, {}, ''), []);
  assert.equal(searchSessions(projects.slice(0, 1), lists, '').length, 2);
  assert.deepEqual(searchSessions(projects, { first: lists.other }, ''), []);
});
