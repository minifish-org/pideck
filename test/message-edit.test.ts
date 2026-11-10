import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatView, Selection } from '../src/shared/api';
import { validPayload } from '../src/main/validation';
import { fauxRuntime, toolResponse, waitForView } from './support/faux-runtime';

const image = { mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRckAAAAASUVORK5CYII=' };
const texts = (view: ChatView) => view.messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pideck-message-edit-'));
  const directory = join(root, 'project');
  await mkdir(directory);
  const engine = fauxRuntime(join(root, 'app'));
  let runtime = await engine.open();
  const project = runtime.addProject(directory);
  const session = await runtime.createSession(project.id);
  const selection: Selection = { projectId: project.id, sessionId: session.id };
  return { ...engine, directory, selection, project, get runtime() { return runtime; },
    input: (text: string) => ({ ...engine.input(selection, text), requestId: randomUUID() }),
    async reopen() { await runtime.close(); runtime = await engine.open(); },
    async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('editing resends from the preceding native checkpoint, reruns tools, and preserves the original history and images', async () => {
  const f = await fixture();
  try {
    for (const [text, answer] of [['Earlier context', 'Earlier answer'], ['Original request', 'Old answer'], ['Later request', 'Later answer']]) {
      f.faux.setResponses([fauxAssistantMessage(answer)]);
      await f.runtime.send({ ...f.input(text), ...(text === 'Original request' ? { images: [image, image] } : {}) });
      await waitForView(f.runtime, f.selection, view => view.status === 'idle' && view.messages.at(-1)?.completed === true && texts(view).includes(answer));
    }
    const original = await waitForView(f.runtime, f.selection, () => true);
    const target = original.messages.find(message => message.role === 'user' && message.blocks.some(block => block.type === 'text' && block.text === 'Original request'))!;
    assert.deepEqual(await f.runtime.readMessageForEdit({ ...f.selection, entryId: target.entryId! }), { text: 'Original request', images: [image, image] });
    let providerContext: unknown;
    f.faux.setResponses([
      request => {
        providerContext = request.messages.filter(message => message.role !== 'system').map(message => message.content);
        return toolResponse('bash', { command: 'printf rerun > edited-result.txt' });
      }, fauxAssistantMessage('Edited work finished'),
    ]);
    const input = { ...f.input('Revised request'), entryId: target.entryId! };
    const [branch, duplicate] = await Promise.all([f.runtime.edit(input), f.runtime.edit(input)]);
    assert.deepEqual(branch, duplicate);
    assert.equal(branch.id, input.requestId);
    assert.equal(branch.parentSessionId, f.selection.sessionId);
    assert.ok(branch.forkEntryId! < target.entryId!);
    const selection = { ...f.selection, sessionId: branch.id };
    const edited = await waitForView(f.runtime, selection, view => view.status === 'idle' && view.messages.at(-1)?.completed === true && texts(view).includes('Edited work finished'));
    assert.deepEqual(texts(edited), ['Earlier context', 'Earlier answer', 'Revised request', 'Edited work finished']);
    assert.deepEqual(edited.messages.find(message => message.requestId === input.requestId)?.blocks,
      [{ type: 'text', text: input.text }, { type: 'image', ...image }, { type: 'image', ...image }]);
    assert.deepEqual(providerContext, ['Earlier context', [{ type: 'text', text: 'Earlier answer' }],
      [{ type: 'text', text: input.text }, { type: 'image', ...image }, { type: 'image', ...image }]]);
    assert.equal(await readFile(join(f.directory, 'edited-result.txt'), 'utf8'), 'rerun');
    assert.deepEqual((await waitForView(f.runtime, f.selection, () => true)).messages, original.messages);
    assert.equal((await f.runtime.listSessions(f.project.id)).length, 2);

    // A lost acknowledgement retried after reopening must not create another
    // branch or rerun tools, even if the model is no longer available.
    await f.reopen();
    const replay = await f.runtime.edit({ ...input, model: { ...input.model, id: 'missing-model' } });
    assert.equal(replay.id, branch.id);
    assert.equal(replay.parentSessionId, branch.parentSessionId);
    assert.equal((await f.runtime.listSessions(f.project.id)).length, 2);
    assert.deepEqual((await waitForView(f.runtime, selection, () => true)).messages, edited.messages);
    await assert.rejects(f.runtime.edit({ ...input, entryId: original.messages[0].entryId! }), /another action/);
  } finally { await f.close(); }
});

test('the first user message can be edited without inheriting its old text or answer', async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('Old answer')]);
    await f.runtime.send(f.input('First original request'));
    const original = await waitForView(f.runtime, f.selection, view => view.status === 'idle' && texts(view).includes('Old answer'));
    f.faux.setResponses([fauxAssistantMessage('New first answer')]);
    const branch = await f.runtime.edit({ ...f.input('First revised request'), entryId: original.messages[0].entryId! });
    const done = await waitForView(f.runtime, { ...f.selection, sessionId: branch.id }, view => view.status === 'idle' && texts(view).includes('New first answer'));
    assert.deepEqual(texts(done), ['First revised request', 'New first answer']);
    assert.deepEqual(texts(await waitForView(f.runtime, f.selection, () => true)), ['First original request', 'Old answer']);
  } finally { await f.close(); }
});

test('message edits validate session ownership, committed user entries, nonempty content, and idle admission', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([fauxAssistantMessage('Old answer')]);
    await f.runtime.send(f.input('Original request'));
    const original = await waitForView(f.runtime, f.selection, view => view.status === 'idle' && texts(view).includes('Old answer'));
    const input = { ...f.input('Replacement'), entryId: original.messages[0].entryId! };
    await assert.rejects(f.runtime.edit({ ...input, text: '  ' }), /Enter a message/);
    await assert.rejects(f.runtime.edit({ ...input, entryId: original.messages[1].entryId! }), /committed user message/);
    const other = await f.runtime.createSession(f.project.id);
    await assert.rejects(f.runtime.readMessageForEdit({ ...input, sessionId: other.id }), /committed user message/);
    await assert.rejects(f.runtime.edit({ ...input, projectId: randomUUID() }), /Project not found/);
    await assert.rejects(f.runtime.edit({ ...input, sessionId: randomUUID() }), /Session not found/);
    f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage('Current answer'); }]);
    await f.runtime.send(f.input('Current work')); await started.promise;
    await assert.rejects(f.runtime.edit(input), /Stop the current run/);
    assert.equal((await f.runtime.listSessions(f.project.id)).length, 2);
    // The edit can be read while running, but resending must wait for a stop.
    assert.equal((await f.runtime.readMessageForEdit(input)).text, 'Original request');
    const stopping = f.runtime.cancel(f.selection); release.resolve(); await stopping;
    f.faux.setResponses([fauxAssistantMessage('Edited answer')]);
    const branch = await f.runtime.edit(input);
    await waitForView(f.runtime, { ...f.selection, sessionId: branch.id }, view => view.status === 'idle' && texts(view).includes('Edited answer'));
  } finally { release.resolve(); await f.close(); }
});

test('a held queued message cannot be bypassed by resending a committed edit', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage('Current answer'); }]);
    await f.runtime.send(f.input('Current request')); await started.promise;
    await f.runtime.send({ ...f.input('Keep this queued request'), delivery: 'follow-up' });
    const queued = await waitForView(f.runtime, f.selection, view => view.queued?.length === 1);
    const lease = { ...f.selection, id: queued.queued![0].id, token: randomUUID() };
    await f.runtime.startQueueEdit(lease, 1);
    release.resolve();
    const idle = await waitForView(f.runtime, f.selection, view => view.status === 'idle' && texts(view).includes('Current answer'));
    await assert.rejects(f.runtime.edit({ ...f.input('Replacement'), entryId: idle.messages[0].entryId! }), /Finish or remove queued messages/);
    assert.equal((await f.runtime.listSessions(f.project.id)).length, 1);
    assert.equal((await f.runtime.readQueuedInput(lease)).text, 'Keep this queued request');
  } finally { release.resolve(); await f.close(); }
});

test('an interrupted edited run reopens through the conversation watch and keeps its idempotent admission', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.faux.setResponses([fauxAssistantMessage('Old answer')]);
    await f.runtime.send(f.input('Original request'));
    const original = await waitForView(f.runtime, f.selection, view => view.status === 'idle' && texts(view).includes('Old answer'));
    f.faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage('Interrupted edited answer'); }]);
    const input = { ...f.input('Revised request that must recover'), entryId: original.messages[0].entryId! };
    const branch = await f.runtime.edit(input);
    await started.promise;
    const selection = { ...f.selection, sessionId: branch.id };
    await waitForView(f.runtime, selection, view => view.status === 'running' && texts(view).includes(input.text));
    const closing = f.runtime.close(); release.resolve(); await closing;
    f.faux.setResponses([fauxAssistantMessage('Recovered edited answer')]);
    await f.reopen();
    const recovered = await waitForView(f.runtime, selection, view => view.status === 'idle'
      && view.messages.at(-1)?.completed === true && texts(view).includes('Recovered edited answer'));
    assert.equal(recovered.messages.filter(message => message.requestId === input.requestId).length, 1);
    assert.ok(!texts(recovered).includes('Original request'));
    assert.equal((await f.runtime.edit(input)).id, branch.id);
    assert.equal((await f.runtime.listSessions(f.project.id)).length, 2);
  } finally { release.resolve(); await f.close(); }
});

test('image-only edits keep every original attachment when resending without text', async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage('Original image answer')]);
    await f.runtime.send({ ...f.input('Original image caption'), images: [image] });
    const original = await waitForView(f.runtime, f.selection, view => view.status === 'idle' && texts(view).includes('Original image answer'));
    f.faux.setResponses([fauxAssistantMessage('Image-only answer')]);
    const branch = await f.runtime.edit({ ...f.input(''), entryId: original.messages[0].entryId! });
    const done = await waitForView(f.runtime, { ...f.selection, sessionId: branch.id }, view => view.status === 'idle' && texts(view).includes('Image-only answer'));
    assert.deepEqual(done.messages[0].blocks, [{ type: 'image', ...image }]);
  } finally { await f.close(); }
});

test('edit IPC requires scoped message and retry identities and bounded text; attachments come only from the host', () => {
  const input = { projectId: randomUUID(), sessionId: randomUUID(), entryId: 42, text: 'Modified message', requestId: randomUUID(),
    model: { provider: 'openai', id: 'model' }, thinking: 'off' };
  assert.equal(validPayload('chat:edit', input), true);
  assert.equal(validPayload('chat:edit', { ...input, text: '' }), true, 'The host checks retained images for image-only edits.');
  assert.equal(validPayload('chat:edit-read', input), true);
  for (const patch of [{ projectId: '../project' }, { sessionId: undefined }, { entryId: 0 }, { entryId: Number.MAX_SAFE_INTEGER + 1 },
    { entryId: '42' }, { requestId: undefined }, { text: 'x'.repeat(200001) }, { text: 'bad\0text' }, { thinking: 'extreme' },
    { images: [image] }, { delivery: 'follow-up' }]) assert.equal(validPayload('chat:edit', { ...input, ...patch }), false);
  for (const entryId of [undefined, 0, -1, '42', Infinity, 1.5]) assert.equal(validPayload('chat:edit-read', { ...input, entryId }), false);
});
