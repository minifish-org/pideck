import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDrafts, retainQueueEditText, saveDrafts, type Attachment, type Draft } from '../src/renderer/preferences';

const projectId = '17b4acb3-33f5-4924-a16e-d777892a6555';
const sessionId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
const token = '94001d79-f370-4352-8f52-606ef6831f48'; // Test-only queue edit token. gitleaks:allow
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

test('queue edits survive a new window and old alternatives migrate into visible unsent text', () => {
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
    assert.deepEqual(JSON.parse(serialized).queueEdit, edited.queueEdit);
    assert.equal(editorStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`), null);
    const reopened = readDrafts()[projectId][sessionId];
    assert.equal(reopened.text, edited.text);
    assert.deepEqual(reopened.queueEdit, edited.queueEdit);
    assert.deepEqual(reopened.attachments, []);
    editorStorage.removeItem(`pideck.draft.v1/${projectId}/${sessionId}`);
    assert.deepEqual(readDrafts()[projectId][sessionId].queueEdit, edited.queueEdit);
    assert.equal(readDrafts()[projectId][sessionId].text, edited.text);
    const pending: Draft = { text: '', attachments: [],
      queueEdit: { id: 9, token, original: '', text: '', hasImages: false, loading: true } };
    saveDrafts(drafts, { [projectId]: { [sessionId]: pending } });
    assert.deepEqual(readDrafts()[projectId][sessionId].queueEdit, pending.queueEdit,
      'the pending reservation is durable before its first host response');
    storage.setItem(`pideck.draft.v1/${projectId}/${sessionId}`, JSON.stringify({ text: edited.text }));
    editorStorage.setItem(`pideck.draft.v1/${projectId}/${sessionId}`, JSON.stringify(edited.queueEdit));
    const migrated = readDrafts();
    assert.deepEqual(migrated[projectId][sessionId].queueEdit, edited.queueEdit);
    saveDrafts({}, migrated);
    assert.equal(editorStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`), null);
    assert.deepEqual(JSON.parse(storage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`)).queueEdit, edited.queueEdit,
      'a previous version window-scoped edit migrates without cancelling it');
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

test('image-only drafts and model/thinking choices restore without embedding images in browser storage', async () => {
  const local = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const session = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = Object.create({
    getItem(this: Record<string, string>, key: string) { return this[key] ?? null; },
    setItem(this: Record<string, string>, key: string, value: string) { this[key] = value; },
    removeItem(this: Record<string, string>, key: string) { delete this[key]; },
  });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: Object.create(Object.getPrototypeOf(storage)), configurable: true });
  try {
    const { persistDraftImages, hydrateDraftImages } = await import('../src/renderer/preferences');
    const snapshots = new Map<string, Attachment[]>();
    const api = { invoke: async (command: string, payload: { key: string; images?: Attachment[] }) => {
      if (command === 'draft:images-write') snapshots.set(payload.key, payload.images!);
      if (command === 'draft:images-read') {
        const images = snapshots.get(payload.key);
        if (!images) throw new Error('unavailable');
        return images.map(image => ({ ...image }));
      }
    } } as unknown as import('../src/shared/api').Pideck;
    const attachments = [{ ...attachment }];
    const attachmentsKey = await persistDraftImages(projectId, sessionId, attachments, api);
    const original: Draft = { text: '', attachments, attachmentsKey, model: 'openai/example', thinking: 'high', pendingRequestId: token };
    const drafts = { [projectId]: { [sessionId]: original } };
    saveDrafts({}, drafts);
    assert.ok(!JSON.stringify(storage).includes(attachment.data));
    const reopened = await hydrateDraftImages(readDrafts(), api);
    assert.deepEqual(reopened[projectId][sessionId].attachments, attachments);
    assert.equal(reopened[projectId][sessionId].model, original.model);
    assert.equal(reopened[projectId][sessionId].thinking, original.thinking);
    assert.equal(reopened[projectId][sessionId].pendingRequestId, token);
    // A changed selection persists even when text and images are unchanged.
    saveDrafts(drafts, { [projectId]: { [sessionId]: { ...original, model: 'openai/other', thinking: 'low' } } });
    assert.equal(readDrafts()[projectId][sessionId].model, 'openai/other');
    assert.equal(readDrafts()[projectId][sessionId].thinking, 'low');
    snapshots.clear();
    const missing = (await hydrateDraftImages(readDrafts(), api))[projectId][sessionId];
    assert.equal(missing.imagesUnavailable, true);
    assert.equal(missing.attachmentsKey, attachmentsKey, 'an unavailable host must not erase the only recovery reference');
    assert.match(missing.error!, /could not be restored/);
  } finally {
    if (local) Object.defineProperty(globalThis, 'localStorage', local); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (session) Object.defineProperty(globalThis, 'sessionStorage', session); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});


test('an acknowledged send clears sent images independently of text typed while awaiting the reply', async () => {
  const { completeAttempt, acceptStartedDraft } = await import('../src/renderer/preferences');
  const attempt = { text: 'Sent text', attachments: [{ ...attachment }], requestId: token };
  const draft: Draft = { text: 'Next unsent text', attachments: attempt.attachments, attempt, sending: true };
  assert.equal(completeAttempt(draft, attempt).text, 'Next unsent text');
  assert.deepEqual(completeAttempt(draft, attempt).attachments, []);
  const images = [{ ...attachment, name: 'new.png' }];
  const kept = completeAttempt({ ...draft, text: attempt.text, attachments: images }, attempt);
  assert.equal(kept.text, '');
  assert.equal(kept.attachments, images);
  assert.equal(acceptStartedDraft({ [projectId]: { draft } }, projectId, token)[projectId][token].text, 'Next unsent text');
  assert.deepEqual(acceptStartedDraft({ [projectId]: { draft } }, projectId, token)[projectId][token].attachments, []);
});

test('draft references publish only committed images and late writes cannot replace new text or resurrect drafts', async () => {
  const descriptors = Object.fromEntries(['localStorage', 'sessionStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = Object.create({
    getItem(this: Record<string, string>, key: string) { return this[key] ?? null; },
    setItem(this: Record<string, string>, key: string, value: string) { this[key] = value; },
    removeItem(this: Record<string, string>, key: string) { delete this[key]; },
  });
  const snapshots = new Map<string, Attachment[]>();
  let gate: Promise<void> = Promise.resolve();
  const api = { invoke: async (_command: string, payload: { key: string; images: Attachment[] }) => {
    await gate; snapshots.set(payload.key, payload.images);
  } } as unknown as import('../src/shared/api').Pideck;
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: Object.create(Object.getPrototypeOf(storage)), configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { pideck: api }, configurable: true });
  const { persistDraftImages, flushDraftImages } = await import('../src/renderer/preferences');
  const tick = async () => { await flushDraftImages(); await new Promise(resolve => setImmediate(resolve)); };
  try {
    const images = [{ ...attachment }];
    const key = await persistDraftImages(projectId, sessionId, images, api);
    const first = { [projectId]: { [sessionId]: { text: 'Old text', attachments: images } } };
    saveDrafts({}, first);
    const pending = Promise.withResolvers<void>(); gate = pending.promise;
    const changed = { [projectId]: { [sessionId]: { text: 'Updated images', attachments: [{ ...attachment, name: 'updated.png' }] } } };
    saveDrafts(first, changed);
    assert.equal(readDrafts()[projectId][sessionId].attachmentsKey, key, 'uncommitted snapshots cannot replace a recovery reference');
    const latest = { [projectId]: { [sessionId]: { ...changed[projectId][sessionId], text: 'Newer text' } } };
    saveDrafts(changed, latest);
    pending.resolve(); await tick();
    const restored = readDrafts()[projectId][sessionId];
    assert.equal(restored.text, 'Newer text');
    assert.notEqual(restored.attachmentsKey, key);
    assert.equal(snapshots.get(restored.attachmentsKey!)?.[0].name, 'updated.png');
    const removing = Promise.withResolvers<void>(); gate = removing.promise;
    const later = { [projectId]: { [sessionId]: { text: 'Do not restore me', attachments: [{ ...attachment, name: 'later.png' }] } } };
    saveDrafts(latest, later);
    saveDrafts(later, {});
    removing.resolve(); await tick();
    assert.deepEqual(readDrafts(), {}, 'a late host acknowledgement must not resurrect a deleted draft');
  } finally {
    await tick();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
