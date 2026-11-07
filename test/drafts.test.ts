import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDrafts, recoverQueueEdit, restoreRecoveredDraft, saveDrafts, type Attachment, type Draft } from '../src/renderer/preferences';

const projectId = '17b4acb3-33f5-4924-a16e-d777892a6555';
const sessionId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
const attachment: Attachment = { data: 'cGljdHVyZQ==', mimeType: 'image/png', name: 'draft.png' };

test('consumed queue edits preserve the normal draft, earlier recoveries and in-memory attachments', () => {
  const original: Draft = { text: 'Unsent normal draft', attachments: [attachment],
    queueEdit: { id: 1, original: 'First queued message', text: 'First revised message', hasImages: false } };
  const first = recoverQueueEdit(original);
  const second = recoverQueueEdit({ ...first,
    queueEdit: { id: 2, original: 'Second queued message', text: 'Second revised message', hasImages: true } });
  assert.equal(second.queueEdit, undefined);
  assert.equal(second.text, original.text);
  assert.equal(second.attachments, original.attachments);
  assert.deepEqual(second.recoveredDrafts?.map(item => item.text), ['First revised message', 'Second revised message']);
  const restored = restoreRecoveredDraft(second);
  assert.equal(restored.text, 'First revised message');
  assert.deepEqual(restored.attachments, []);
  assert.deepEqual(restored.recoveredDrafts?.map(item => item.text), ['Second revised message', original.text]);
  assert.equal(restored.recoveredDrafts?.at(-1)?.attachments, original.attachments);
  const empty: Draft = { text: '', attachments: [], queueEdit: original.queueEdit };
  assert.equal(recoverQueueEdit(empty).text, 'First revised message');
  assert.equal(recoverQueueEdit({ ...empty, queueEdit: { ...original.queueEdit!, text: 'First queued message' } }).text, '');
});

test('queue editing and recoveries survive reload without serializing images, then disappear with their session', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = Object.create({
    getItem(this: Record<string, string>, key: string) { return Object.hasOwn(this, key) ? this[key] : null; },
    setItem(this: Record<string, string>, key: string, value: string) { this[key] = value; },
    removeItem(this: Record<string, string>, key: string) { delete this[key]; },
  });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    const edited: Draft = { text: '', attachments: [attachment],
      queueEdit: { id: 9, original: 'Queued original', text: 'Revised queued draft', hasImages: true },
      recoveredDrafts: [{ text: 'Earlier saved edits', attachments: [attachment] }] };
    const drafts = { [projectId]: { [sessionId]: edited } };
    saveDrafts({}, drafts);
    const serialized = storage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`);
    assert.ok(serialized);
    assert.ok(!serialized.includes(attachment.data));
    const reopened = readDrafts()[projectId][sessionId];
    assert.equal(reopened.text, '');
    assert.deepEqual(reopened.queueEdit, edited.queueEdit);
    assert.deepEqual(reopened.attachments, []);
    assert.deepEqual(reopened.recoveredDrafts, [{ text: 'Earlier saved edits', attachments: [] }]);
    saveDrafts(drafts, {});
    assert.deepEqual(readDrafts(), {});
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
