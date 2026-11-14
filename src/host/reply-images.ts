import { isAbsolute, relative, resolve } from 'node:path';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import type { Conversation, EntryId } from '@earendil-works/pi-durable';
import type { ChatImageRef, ImageInput } from '../shared/api.js';
import { localMessageImagePath } from '../shared/message-links.js';
import { readMessageImage } from './message-links.js';

type ReplyImage = ImageInput & { source: 'conversation' | 'file' };

// No second attachment store: immutable screenshots come from Durable's native
// read-tool results, including inherited fork history. Only call/image
// references are retained between bounded pages; no second image store.
export async function resolveReplyImage(conversation: Conversation, directory: string, entryId: number, href: string,
  automationDirectory?: string, signal?: AbortSignal): Promise<ReplyImage> {
  signal?.throwIfAborted();
  const path = localMessageImagePath(href);
  if (!path) throw new Error('Remote and embedded images are not loaded automatically.');
  const scope = withCancel(BACKGROUND_CONTEXT);
  const stop = () => scope.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const answer = (await conversation.entries({ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }, 1, undefined, scope.context)).items[0];
    if (answer?.kind !== 'pi.assistant') throw new Error('This reply is no longer available in this conversation.');
    const absolute = resolve(directory, path);
    const pending = new Map<string, ChatImageRef>();
    let cursor: Awaited<ReturnType<Conversation['entries']>>['next'];
    // Bound work for very old, image-heavy conversations. The file fallback is
    // explicitly labelled current, never presented as a historical snapshot.
    for (let remaining = 2048; remaining > 0; remaining -= 32) {
      signal?.throwIfAborted();
      const page = await conversation.entries({ maxEntryId: (entryId - 1) as EntryId, order: 'descending' }, 32, cursor, scope.context);
      for (const entry of page.items) {
        for (let messageIndex = (entry.model?.length ?? 0) - 1; messageIndex >= 0; messageIndex--) {
          const message = entry.model![messageIndex]!;
          if (message.role === 'toolResult' && !message.isError) {
            const contentIndex = message.content.findIndex(block => block.type === 'image');
            if (contentIndex >= 0) pending.set(message.toolCallId, { entryId: entry.id, messageIndex, contentIndex });
          } else if (message.role === 'assistant') {
            for (const block of message.content) {
              if (block.type !== 'toolCall' || block.name !== 'read' || typeof block.arguments.path !== 'string') continue;
              const ref = pending.get(block.id);
              if (!ref || resolve(directory, block.arguments.path) !== absolute) continue;
              const saved = (await conversation.entries({ minEntryId: ref.entryId as EntryId, maxEntryId: ref.entryId as EntryId }, 1, undefined, scope.context)).items[0];
              const result = saved?.model?.[ref.messageIndex];
              const image = result?.role === 'toolResult' ? result.content[ref.contentIndex] : undefined;
              if (image?.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
                || image.data.length > 16_000_000) throw new Error('This saved image cannot be previewed.');
              signal?.throwIfAborted();
              return { mimeType: image.mimeType as ImageInput['mimeType'], data: image.data, source: 'conversation' };
            }
          }
        }
      }
      cursor = page.next;
      if (!cursor) break;
    }
    // Realpath confinement and race-resistant reads run again in the reader.
    // A sibling session's automation output is never an admitted root.
    const roots = [directory, automationDirectory].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      const scoped = relative(root, absolute);
      if (!scoped || isAbsolute(scoped) || scoped === '..' || scoped.startsWith('../') || scoped.startsWith('..\\')) continue;
      return { ...await readMessageImage(root, scoped.split('\\').join('/'), signal), source: 'file' };
    }
    throw new Error('This image is outside the project and this conversation’s screenshot directory.');
  } finally {
    signal?.removeEventListener('abort', stop);
    scope.cancel();
  }
}
