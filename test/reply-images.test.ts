import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { validPayload } from '../src/main/validation';
import { localMessageImagePath } from '../src/shared/message-links';
import { readMessageImage } from '../src/host/message-links';
import { fauxRuntime, toolResponse, waitForView } from './support/faux-runtime';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('reply images prefer immutable native read results across overwrites, restarts and inherited fork history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pideck-reply-images-'));
  const directory = join(root, 'project');
  await mkdir(directory);
  const fixture = fauxRuntime(join(root, 'app'));
  let runtime = await fixture.open();
  try {
    const project = runtime.addProject(directory);
    const session = await runtime.createSession(project.id);
    const selection = { projectId: project.id, sessionId: session.id };
    const outside = join(root, 'outside.png');
    await writeFile(join(directory, 'screen shot.png'), Buffer.from(png, 'base64'));
    await writeFile(outside, Buffer.from(png, 'base64'));
    const reply = '![Screenshot](screen%20shot.png)';
    fixture.faux.setResponses([toolResponse('read', { path: 'screen shot.png' }), toolResponse('read', { path: outside }), fauxAssistantMessage(reply)]);
    await runtime.send(fixture.input(selection, 'Read the screenshots.'));
    const hasReply = (message: { blocks: { type: string; text?: string }[] }) => message.blocks.some(block => block.type === 'text' && block.text === reply);
    const view = await waitForView(runtime, selection, view => view.status === 'idle' && view.messages.some(hasReply));
    const answer = view.messages.find(hasReply)!;
    const input = { ...selection, entryId: answer.entryId!, href: 'screen%20shot.png', requestId: randomUUID() };
    const expected = { mimeType: 'image/png', data: png, source: 'conversation' };
    assert.deepEqual(await runtime.readReplyImage(input), expected);
    await writeFile(join(directory, 'screen shot.png'), '<script>changed()</script>');
    await rm(outside);
    assert.deepEqual(await runtime.readReplyImage(input), expected);
    assert.deepEqual(await runtime.readReplyImage({ ...input, href: outside }), expected, 'An already saved native result is owned by this conversation, not the current filesystem.');
    const other = await runtime.createSession(project.id);
    await assert.rejects(runtime.readReplyImage({ ...input, sessionId: other.id }), /no longer available/);
    const otherProject = runtime.addProject(root);
    await assert.rejects(runtime.readReplyImage({ ...input, projectId: otherProject.id }), /Session not found/);
    await assert.rejects(runtime.readReplyImage({ ...input, entryId: view.messages[0]!.entryId! }), /reply is no longer/);
    const branch = await runtime.fork(selection, answer.entryId!);
    assert.deepEqual(await runtime.readReplyImage({ ...input, sessionId: branch.id }), expected);
    const early = await runtime.fork(selection, view.messages[0]!.entryId!);
    await assert.rejects(runtime.readReplyImage({ ...input, sessionId: early.id }), /reply is no longer/);
    await runtime.close(); runtime = await fixture.open();
    assert.deepEqual(await runtime.readReplyImage(input), expected);
    await assert.rejects(runtime.readReplyImage(input, AbortSignal.abort(new Error('Image stopped.'))), /Image stopped/);

    await writeFile(join(directory, 'current.png'), Buffer.from(png, 'base64'));
    assert.deepEqual(await runtime.readReplyImage({ ...input, href: './current.png' }), { ...expected, source: 'file' });
    await writeFile(outside, Buffer.from(png, 'base64'));
    await symlink(outside, join(directory, 'escape.png'));
    await assert.rejects(runtime.readReplyImage({ ...input, href: 'escape.png' }), /outside/);
    await assert.rejects(runtime.readReplyImage({ ...input, href: '../unknown.png' }), /outside/);
    for (const href of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', '//server/share.png']) {
      await assert.rejects(runtime.readReplyImage({ ...input, href }), /Remote and embedded/);
    }
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('raster file previews sniff bytes, bound reads and reject symlinks, SVG and HTML regardless of extension', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pideck-raster-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'raster.unknown'), Buffer.from(png, 'base64'));
  assert.deepEqual(await readMessageImage(root, 'raster.unknown'), { mimeType: 'image/png', data: png });
  for (const contents of ['<svg><script>evil()</script></svg>', '<html>test</html>', '']) {
    await writeFile(join(root, 'fake.png'), contents);
    await assert.rejects(readMessageImage(root, 'fake.png'), /Only PNG/);
  }
  await writeFile(join(root, 'large.png'), Buffer.alloc(12_000_001));
  await assert.rejects(readMessageImage(root, 'large.png'), /12 MB/);
  await assert.rejects(readMessageImage(root, 'missing.png'), /no longer available/);
  await assert.rejects(readMessageImage(root, '../outside.png'), /inside/);
});

test('reply image IPC requires owned, bounded selection, entry and cancellation identities', () => {
  const input = { projectId: randomUUID(), sessionId: randomUUID(), entryId: 4, href: 'output/screen.png', requestId: randomUUID() };
  assert.equal(validPayload('chat:reply-image', input), true);
  assert.equal(validPayload('chat:reply-image-cancel', input), true);
  for (const change of [{ projectId: 'x' }, { sessionId: '' }, { requestId: 'x' }, { entryId: 0 }, { entryId: 1.2 },
    { href: '' }, { href: 'a\n.png' }, { href: 'x'.repeat(16385) }]) assert.equal(validPayload('chat:reply-image', { ...input, ...change }), false);
  assert.equal(validPayload('chat:reply-image-cancel', { ...input, sessionId: 'x' }), false);
  assert.equal(localMessageImagePath('screens/%E5%9B%BE%20%23.png?x=1'), 'screens/图 #.png');
  assert.equal(localMessageImagePath('C:\\Repo\\image.png'), 'C:/Repo/image.png');
  for (const href of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'file:///image.png', '//server/image.png',
    '%2F%2Fserver/image.png', 'a%00.png', 'bad%', ' a.png']) assert.equal(localMessageImagePath(href), undefined, href);
});
