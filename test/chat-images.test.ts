import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatImage, ChatView } from '../src/shared/api';
import { validPayload } from '../src/main/validation';
import { fauxRuntime, toolResponse, waitForView } from './support/faux-runtime';

test('deferred user and tool images remain readable after history loading, reopening and forks without exposing other conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck-chat-images-'));
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const fixture = fauxRuntime(join(root, 'app'));
  let runtime = await fixture.open();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const images = [{ mimeType: 'image/png' as const, data: 'AAAA'.repeat(1_500_000) },
    { mimeType: 'image/png' as const, data: 'BBBB'.repeat(2_000_000) }];
  try {
    const project = runtime.addProject(projectDir);
    const session = await runtime.createSession(project.id);
    const selection = { projectId: project.id, sessionId: session.id };
    await writeFile(join(projectDir, 'screenshot.png'), Buffer.from(png, 'base64'));
    for (let index = 0; index < 3; index++) {
      fixture.faux.setResponses([...(index === 0 ? [toolResponse('read', { path: 'screenshot.png' })] : []),
        fauxAssistantMessage(`Done ${index}`)]);
      await runtime.send({ ...fixture.input(selection, `Image ${index}`), requestId: randomUUID(), images: [images[index === 0 ? 0 : 1]] });
      await waitForView(runtime, selection, view => view.status === 'idle' && view.messages.some(message =>
        message.blocks.some(block => block.type === 'text' && block.text === `Done ${index}`)));
    }
    const deferred = (view: ChatView): ChatImage[] => view.messages.flatMap(message => message.blocks.flatMap(block =>
      block.type === 'image' ? [block] : block.type === 'tool' ? block.images ?? [] : [])).filter(image => image.ref);
    let view = await waitForView(runtime, selection, () => true);
    const refs = deferred(view).map(image => image.ref!);
    assert.equal(refs.length, 2);
    assert.ok(deferred(view).every(image => image.data === ''));
    assert.deepEqual(await runtime.readChatImage({ ...selection, ...refs[0] }), images[0]);
    assert.deepEqual(await runtime.readChatImage({ ...selection, ...refs[1] }), { mimeType: 'image/png', data: png });
    const watch = await runtime.watch(selection, () => {});
    await watch.loadEarlier(); watch.dispose();
    const other = await runtime.createSession(project.id);
    await assert.rejects(runtime.readChatImage({ ...selection, sessionId: other.id, ...refs[0] }), /no longer available/);
    const otherProject = runtime.addProject(root);
    await assert.rejects(runtime.readChatImage({ ...selection, projectId: otherProject.id, ...refs[0] }), /Session not found/);
    await assert.rejects(runtime.readChatImage({ ...selection, ...refs[0], contentIndex: 1000 }), /no longer available/);
    const firstAnswer = view.messages.find(message => message.role === 'assistant' && message.completed)!;
    const branch = await runtime.fork(selection, firstAnswer.entryId!);
    assert.deepEqual(await runtime.readChatImage({ ...selection, sessionId: branch.id, ...refs[0] }), images[0]);
    const lastImageEntry = view.messages.filter(message => message.role === 'user').at(-1)!.entryId!;
    await assert.rejects(runtime.readChatImage({ ...selection, sessionId: branch.id,
      entryId: lastImageEntry, messageIndex: 0, contentIndex: 1 }), /no longer available/);
    await runtime.close(); runtime = await fixture.open();
    view = await waitForView(runtime, selection, () => true);
    assert.deepEqual(deferred(view).map(image => image.ref!), refs);
    assert.deepEqual(await runtime.readChatImage({ ...selection, ...refs[0] }), images[0]);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('historical image IPC accepts only scoped, bounded transcript coordinates', () => {
  const input = { projectId: randomUUID(), sessionId: randomUUID(), entryId: 3, messageIndex: 0, contentIndex: 1 };
  assert.equal(validPayload('chat:image', input), true);
  const invalid: Record<string, unknown>[] = [{ projectId: '../outside' }, { sessionId: '' }, { entryId: 0 },
    { entryId: Number.MAX_SAFE_INTEGER + 1 }, { messageIndex: -1 }, { contentIndex: 0.5 }, { contentIndex: 10_001 }];
  for (const change of invalid) assert.equal(validPayload('chat:image', { ...input, ...change }), false);
});
