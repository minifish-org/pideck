import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { safeFailureDetail } from '../src/host/failure-detail';
import { RendererRecovery } from '../src/main/renderer-recovery';
import { sessionTree } from '../src/renderer/session-tree';
import { validPayload } from '../src/main/validation';
import type { Session } from '../src/shared/api';
import { fauxRuntime, waitForView } from './support/faux-runtime';

const id = () => randomUUID();

test('failure details distinguish provider errors and redact credentials, controls, URLs, and long responses', () => {
  assert.equal(safeFailureDetail(undefined), undefined);
  assert.match(safeFailureDetail('401 Unauthorized: invalid credential')!, /401/);
  assert.match(safeFailureDetail('429 quota exhausted')!, /429/);
  const secret = 'audit-placeholder-private-value';
  const safe = safeFailureDetail(`\x1b[31m401\x1b[0m Authorization: Bearer ${secret}\n{"api_key":"${secret}", "refresh_token": "${secret}"}\nhttps://user:${secret}@example.com/path?key=${secret}\nsecret=${secret}`)!;
  assert.ok(!safe.includes(secret), safe);
  assert.ok(!safe.includes('\x1b'));
  assert.ok(!safe.includes('user:'));
  assert.ok(safeFailureDetail('x'.repeat(8000))!.length <= 1200);
});

test('renderer recovery automatically retries once per interval, and only an explicit retry resets a crash loop', () => {
  const recovery = new RendererRecovery(100);
  assert.equal(recovery.automatic(0), true);
  assert.equal(recovery.automatic(1), false);
  assert.equal(recovery.automatic(99), false);
  assert.equal(recovery.automatic(100), true);
  assert.equal(recovery.automatic(101), false);
  recovery.retry();
  assert.equal(recovery.automatic(102), true);
  assert.equal(recovery.automatic(103), false);
});

test('session tree follows immutable IDs, keeps sibling recency, folds branches, and tolerates missing/cyclic ancestry', () => {
  const session = (id: string, parentSessionId?: string): Session => ({ id, parentSessionId, projectId: 'project', title: 'same title', createdAt: 0, updatedAt: 0 });
  const sessions = [session('new-child', 'root'), session('grandchild', 'old-child'), session('other'), session('old-child', 'root'), session('root')];
  assert.deepEqual(sessionTree(sessions).map(row => [row.session.id, row.depth]),
    [['other', 0], ['root', 0], ['new-child', 1], ['old-child', 1], ['grandchild', 2]]);
  assert.deepEqual(sessionTree(sessions, { root: true }).map(row => row.session.id), ['other', 'root']);
  assert.deepEqual(sessionTree([session('orphan', 'missing'), session('cycle-a', 'cycle-b'), session('cycle-b', 'cycle-a')]).map(row => row.depth), [0, 0, 0]);
});

test('native fork ancestry and host draft images survive reopen, enforce project ownership, and purge with the session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pideck-reliability-'));
  const otherDirectory = await mkdtemp(join(tmpdir(), 'pideck-reliability-other-'));
  const fixture = fauxRuntime(directory);
  let runtime = await fixture.open();
  try {
    const project = runtime.addProject(directory);
    const other = runtime.addProject(otherDirectory);
    const source = await runtime.createSession(project.id, 'Source');
    const selection = { projectId: project.id, sessionId: source.id };
    fixture.faux.setResponses([fauxAssistantMessage('Ready to fork.')]);
    await runtime.send(fixture.input(selection, 'Start.'));
    const view = await waitForView(runtime, selection, view => view.status === 'idle' && view.messages.some(message => message.role === 'assistant'));
    const entryId = view.messages.find(message => message.role === 'assistant')!.entryId!;
    const child = await runtime.fork(selection, entryId);
    const grandchild = await runtime.fork({ ...selection, sessionId: child.id }, entryId);
    const image = { name: 'draft.png', mimeType: 'image/png' as const, data: 'aW1hZ2U=' };
    const ref = { projectId: project.id, draftId: grandchild.id, key: id() };
    runtime.writeDraftImages({ ...ref, images: [image] });
    assert.throws(() => runtime.readDraftImages({ ...ref, projectId: other.id }), /not found/i);
    assert.throws(() => runtime.writeDraftImages({ ...ref, projectId: other.id, images: [image] }), /not found/i);
    assert.throws(() => runtime.readDraftImages({ ...ref, key: id() }), /unavailable/i);
    await runtime.close();
    runtime = await fixture.open();
    const sessions = await runtime.listSessions(project.id);
    assert.equal(sessions.find(item => item.id === child.id)?.parentSessionId, source.id);
    assert.equal(sessions.find(item => item.id === grandchild.id)?.parentSessionId, child.id);
    assert.equal(sessions.find(item => item.id === grandchild.id)?.forkEntryId, entryId);
    assert.deepEqual(runtime.readDraftImages(ref), [image]);
    const plan = runtime.removalPlan({ projectId: project.id, sessionId: grandchild.id });
    await runtime.remove({ projectId: project.id, sessionId: grandchild.id }, plan.scope);
    assert.throws(() => runtime.readDraftImages(ref), /not found/i);
    assert.equal((await runtime.listSessions(project.id)).length, 2);
  } finally {
    await runtime.close();
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(otherDirectory, { recursive: true, force: true })]);
  }
});

test('new attachment and terminal visibility IPC validates scope, images, snapshot IDs, and sizes', () => {
  const ref = { projectId: id(), draftId: id(), key: id() };
  assert.equal(validPayload('draft:images-read', ref), true);
  assert.equal(validPayload('draft:images-read', { ...ref, draftId: 'draft' }), true);
  assert.equal(validPayload('draft:images-read', { ...ref, draftId: '../foreign' }), false);
  assert.equal(validPayload('draft:images-write', { ...ref, images: [{ name: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] }), true);
  assert.equal(validPayload('draft:images-write', { ...ref, images: [{ name: 'image', data: 'broken', mimeType: 'image/png' }] }), false);
  assert.equal(validPayload('draft:images-write', { ...ref, images: Array(5).fill({ name: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }) }), false);
  assert.equal(validPayload('terminal:visibility', { projectId: id(), terminalId: id(), visible: false }), true);
  assert.equal(validPayload('terminal:visibility', { projectId: id(), terminalId: id(), visible: 'false' }), false);
});
