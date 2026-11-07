import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDrafts, retainQueueEditText, saveDrafts, type Attachment, type Draft } from '../src/renderer/preferences';

const projectId = '17b4acb3-33f5-4924-a16e-d777892a6555';
const sessionId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
const token = '94001d79-f370-4352-8f52-606ef6831f48';
const attachment: Attachment = { data: 'cGljdHVyZQ==', mimeType: 'image/png', name: 'draft.png' };

test('a stopped or expired editor keeps unsaved text in the ordinary draft without another draft list', () => {
  const original: Draft = { text: 'Unsent normal draft', attachments: [attachment],
    queueEdit: { id: 1, token, original: 'Queued message', text: 'Revised message', hasImages: false } };
  const kept = retainQueueEditText(original);
  assert.equal(kept.queueEdit, undefined);
  assert.equal(kept.text, 'Unsent normal draft\n\nRevised message');
  assert.equal(kept.attachments, original.attachments);
  assert.equal(retainQueueEditText(kept), kept);
  const empty: Draft = { text: '', attachments: [], queueEdit: original.queueEdit };
  assert.equal(retainQueueEditText(empty).text, 'Revised message');
  assert.equal(retainQueueEditText({ ...original, text: 'Revised message' }).text, 'Revised message');
  assert.equal(retainQueueEditText({ ...empty, queueEdit: { ...original.queueEdit!, text: 'Queued message' } }).text, '');
});

test('queue edit tokens survive reload and old alternatives migrate into visible unsent text', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = Object.create({
    getItem(this: Record<string, string>, key: string) { return Object.hasOwn(this, key) ? this[key] : null; },
    setItem(this: Record<string, string>, key: string, value: string) { this[key] = value; },
    removeItem(this: Record<string, string>, key: string) { delete this[key]; },
  });
  const editorStorage = Object.create(Object.getPrototypeOf(storage));
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: editorStorage, configurable: true });
  try {
    const edited: Draft = { text: 'Ordinary draft', attachments: [attachment],
      queueEdit: { id: 9, token, original: 'Queued original', text: 'Revised queued draft', hasImages: true } };
    const drafts = { [projectId]: { [sessionId]: edited } };
    saveDrafts({}, drafts);
    const serialized = storage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`);
    assert.ok(serialized);
    assert.ok(!serialized.includes(attachment.data));
    assert.doesNotMatch(serialized, /queueEdit|token/);
    assert.ok(editorStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`).includes(token));
    const reopened = readDrafts()[projectId][sessionId];
    assert.equal(reopened.text, edited.text);
    assert.deepEqual(reopened.queueEdit, edited.queueEdit);
    assert.deepEqual(reopened.attachments, []);
    editorStorage.removeItem(`pideck.draft.v1/${projectId}/${sessionId}`);
    assert.equal(readDrafts()[projectId][sessionId].queueEdit, undefined);
    assert.equal(readDrafts()[projectId][sessionId].text, edited.text);
    storage.setItem(`pideck.draft.v1/${projectId}/${sessionId}`, JSON.stringify({
      text: 'Legacy current draft', recoveredDrafts: [{ text: 'Legacy saved draft' }, { text: 'Legacy current draft' }],
      queueEdit: { id: 9, original: 'Queued original', text: 'Old unsaved edit', hasImages: false },
    }));
    const legacy = readDrafts()[projectId][sessionId];
    assert.equal(legacy.text, 'Legacy current draft\n\nLegacy saved draft\n\nOld unsaved edit');
    assert.equal(legacy.queueEdit, undefined);
    saveDrafts({}, { [projectId]: { [sessionId]: legacy } });
    assert.deepEqual(readDrafts()[projectId][sessionId], legacy);
    assert.doesNotMatch(storage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`)!, /recoveredDrafts|recoveryKind/);
    saveDrafts(drafts, {});
    assert.deepEqual(readDrafts(), {});
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (windowDescriptor) Object.defineProperty(globalThis, 'sessionStorage', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
