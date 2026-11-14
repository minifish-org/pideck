import { lazy, memo, Suspense, useEffect, useState } from 'react';
import type { ChatBlock, ChatMessage, Project, Selection } from '../shared/api';
import { Icon } from './Icons';
import { ImageBlock } from './ChatImage';
import { MessageFooter } from './MessageFooter';
import { MessageMarkdown } from './MessageMarkdown';
import { readableError } from './conversation';

const InlineDiff = lazy(() => import('./ReviewPanel').then(({ InlineDiff }) => ({ default: InlineDiff })));

export type ReviewSelection = { path?: string; patch?: string; line?: number };
type ToolBlock = Extract<ChatBlock, { type: 'tool' }>;

const toolLabels: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Shell' };
const toolIcons = { read: 'eye', write: 'filePlus', edit: 'edit', bash: 'terminal' } as const;

function ToolCard({ block, onReview, expanded, onExpand, onCancel, selection }: {
  block: ToolBlock;
  onReview: (selection: ReviewSelection) => void;
  expanded?: boolean;
  onExpand: (id: string, expanded: boolean) => void;
  onCancel?: (taskId: number) => Promise<void>;
  selection?: Selection;
}) {
  const [cancellingTask, setCancellingTask] = useState<number>();
  const [cancelError, setCancelError] = useState<string>();
  const command = block.arguments?.command;
  const argPath = block.arguments?.path;
  const path = block.path ?? (typeof argPath === 'string' ? argPath : undefined);
  const target = typeof command === 'string' ? command : path;
  const shell = block.name === 'bash';
  const knownTool = Object.hasOwn(toolIcons, block.name);
  const label = toolLabels[block.name] ?? block.name;
  const showReview = (block.name === 'edit' || block.name === 'write') && path && block.status === 'done';
  const active = block.status === 'pending' || block.status === 'running';
  const cancelling = block.cancelling || cancellingTask === block.taskId && cancellingTask !== undefined;
  const status = block.cancelled ? 'Cancelled' : block.status === 'error' ? 'Failed' : shell && block.status === 'done' ? 'Succeeded' : undefined;
  const output = block.output?.trimEnd();
  const shortOutput = output && output.length <= 420 && output.split('\n', 7).length <= 6;
  const open = expanded ?? (Boolean(block.patch) || block.status === 'error' || (shell && Boolean(active || shortOutput)));
  useEffect(() => {
    if (!active || cancellingTask !== block.taskId) setCancellingTask(undefined);
    setCancelError(undefined);
  }, [active, block.taskId]);

  return (
    <details className="tool-card" open={open} data-command-expanded={shell && expanded === true || undefined}>
      <summary title={target} aria-label={[label, target].filter(Boolean).join(' ')}
        aria-description={active ? cancelling ? 'Cancelling' : block.status === 'running' ? 'Running' : 'Queued' : status} onClick={(event) => {
        event.preventDefault();
        const selection = shell && event.detail > 0 ? window.getSelection() : null;
        if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
        onExpand(block.id, !open);
      }}>
        <span className="tool-icon" title={label}><Icon name={active ? 'spinner' : knownTool ? toolIcons[block.name as keyof typeof toolIcons] : 'file'}
          className={active ? 'tool-spinner' : undefined} /></span>
        {(!knownTool || !target) && <span className="tool-label">{label}</span>}
        {target && <span className={shell ? 'tool-target tool-target--command' : 'tool-target'}>{target}</span>}
        {status && <span className="tool-state" data-status={block.cancelled ? 'cancelled' : block.status} role="status" aria-label={status} title={status}>
          <Icon name={block.cancelled ? 'stop' : block.status === 'error' ? 'alert' : 'check'} width={14} height={14} />
        </span>}
        {active && block.taskId !== undefined && onCancel && <button className="icon-button tool-cancel" type="button"
          aria-label="Cancel this tool" title={cancelling ? 'Cancelling this tool…' : 'Cancel this tool'}
          disabled={Boolean(cancelling)} aria-busy={cancelling || undefined}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
              if (event.repeat) event.preventDefault();
            }
          }} onClick={async event => {
            event.preventDefault();
            event.stopPropagation();
            if (event.detail > 1 || cancelling || block.taskId === undefined) return;
            setCancellingTask(block.taskId);
            setCancelError(undefined);
            try { await onCancel(block.taskId); }
            catch (error) {
              setCancelError(readableError(error));
              setCancellingTask(undefined);
              onExpand(block.id, true);
            }
          }}><Icon name={cancelling ? 'spinner' : 'stop'} className={cancelling ? 'tool-spinner' : undefined} width={13} height={13} /></button>}
        <Icon className="tool-caret" name="chevron" width={12} height={12} />
      </summary>
      <div className="tool-detail">
        {cancelError && <div className="tool-action-error" role="alert">{cancelError}</div>}
        {block.patch
          ? <Suspense fallback={<div className="panel-loading" role="status">Loading diff…</div>}>
              <InlineDiff patch={block.patch} onOpen={() => onReview({ path, patch: block.patch })} />
            </Suspense>
          : <>
              {block.output && <pre className="tool-output">{block.output}</pre>}
              {showReview && <button className="inline-action tool-review" type="button"
                onClick={() => onReview({ path })}>Open in Changes <span aria-hidden="true">↗</span></button>}
            </>}
        {block.images?.map((image, index) => <ImageBlock key={index} image={image} alt={`Output from ${block.name}`} selection={selection} />)}
      </div>
    </details>
  );
}

export const Message = memo(function Message({ message, project, selection, onReview, onFork, toolDisclosure, onToolExpand, onCancelTool }: {
  message: ChatMessage;
  project: Project;
  selection?: Selection;
  onReview: (selection: ReviewSelection) => void;
  onFork?: (entryId: number) => void;
  toolDisclosure: ReadonlyMap<string, boolean>;
  onToolExpand: (id: string, expanded: boolean) => void;
  onCancelTool?: (taskId: number) => Promise<void>;
}) {
  if (message.role === 'assistant' && !message.blocks.length && !message.error) return null;
  const author = message.role === 'user' ? 'You' : 'Pideck';
  const toolOnly = message.role === 'assistant' && message.blocks.some(block => block.type === 'tool')
    && message.blocks.every(block => block.type === 'tool' || block.type === 'thinking');
  const entryId = message.entryId;
  const readingEntry = entryId ?? /^(\d+):\d+$/.exec(message.id)?.[1];
  return (
    <article className={`chat-entry chat-entry--${message.role}`} aria-label={author} data-message-id={message.id} data-tools-only={toolOnly || undefined}
      data-reading-entry={readingEntry}>
      <div className="message-content">
        {message.blocks.map((block, index) => {
          switch (block.type) {
            case 'text':
              return message.role === 'user'
                ? <div key={index}>{block.text}</div>
                : <MessageMarkdown key={index} text={block.text} project={project} selection={selection} entryId={entryId}
                  streaming={message.id === 'live-assistant'} onReview={onReview} />;
            case 'thinking':
              return block.text && <details className="thinking" key={index}><summary>Thinking</summary><pre>{block.text}</pre></details>;
            case 'image':
              return <ImageBlock image={block} alt="Attached image" key={index} selection={selection} />;
            case 'tool':
              return <ToolCard block={block} onReview={onReview} key={block.id}
                expanded={toolDisclosure.get(block.id)} onExpand={onToolExpand} onCancel={onCancelTool} selection={selection} />;
          }
        })}
        {message.error && <div className="dialog-error">{message.error}</div>}
      </div>
      {(message.role === 'user' || message.completed) && <MessageFooter message={message} onFork={onFork} toolOnly={toolOnly} />}
    </article>
  );
});
