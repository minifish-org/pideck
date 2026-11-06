import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatBlock, ChatGap, ChatMessage, ChatView, ImageInput, ModelOption, Project, SendChat, Session, Thinking } from '../shared/api';
import { Icon } from './Icons';
import { readableError, useConversation } from './conversation';
import { ModelPicker, modelKey, providerLabel } from './ModelPicker';
import type { Attachment, Draft, SendAttempt } from './preferences';

const InlineDiff = lazy(() => import('./ReviewPanel').then(({ InlineDiff }) => ({ default: InlineDiff })));

type ReviewSelection = { path?: string; patch?: string };

function imageSource(image: { mimeType: string; data: string }) {
  const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!supported.includes(image.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return undefined;
  return `data:${image.mimeType};base64,${image.data}`;
}

function ImageBlock({ image, alt }: { image: { mimeType: string; data: string }; alt: string }) {
  const source = imageSource(image);
  return source ? <img className="message-image" src={source} alt={alt} /> : null;
}

const toolLabels: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Shell' };
const thinkingLabels: Record<Thinking, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};

function ToolCard({ block, onReview }: {
  block: Extract<ChatBlock, { type: 'tool' }>;
  onReview: (selection: ReviewSelection) => void;
}) {
  const command = block.arguments?.command;
  const argPath = block.arguments?.path;
  const path = block.path ?? (typeof argPath === 'string' ? argPath : undefined);
  const target = typeof command === 'string' ? command : path;
  const showReview = (block.name === 'edit' || block.name === 'write') && path && block.status === 'done';
  const status = { pending: 'Queued', running: 'Running', done: undefined, error: 'Failed' }[block.status];
  const longCommand = typeof command === 'string' && (command.includes('\n') || command.length > 48);
  const [expanded, setExpanded] = useState<boolean>();

  return (
    <details className="tool-card" open={expanded ?? (Boolean(block.patch) || block.name === 'bash' || block.status === 'error')}>
      <summary title={target} onClick={(event) => {
        event.preventDefault();
        const details = event.currentTarget.parentElement as HTMLDetailsElement;
        setExpanded(!details.open);
      }}>
        <Icon name={block.name === 'bash' ? 'terminal' : 'file'} />
        <span className="tool-label">{toolLabels[block.name] ?? block.name}</span>
        {target && <span className="tool-target">{target}</span>}
        {status && <span className={`tool-state ${block.status === 'error' ? 'tool-state--error' : ''}`}>{status}</span>}
        <Icon className="tool-caret" name="chevron" width={12} height={12} />
      </summary>
      <div className="tool-detail">
        {longCommand && <div className="tool-command">$ {command}</div>}
        {block.patch
          ? <Suspense fallback={<div className="panel-loading" role="status">Loading diff…</div>}>
              <InlineDiff patch={block.patch} onOpen={() => onReview({ path, patch: block.patch })} />
            </Suspense>
          : <>
              {block.output && <pre className="tool-output">{block.output}</pre>}
              {showReview && <button className="inline-action tool-review" type="button"
                onClick={() => onReview({ path })}>Open in review <span aria-hidden="true">↗</span></button>}
            </>}
        {block.images?.map((image, index) => <ImageBlock key={index} image={image} alt={`Output from ${block.name}`} />)}
      </div>
    </details>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
      a: ({ children, href }) => <span className="markdown-link" title={href}>{children}</span>,
      img: ({ alt }) => <span>{alt}</span>,
    }}>{text}</ReactMarkdown>
  </div>;
});

const Message = memo(function Message({ message, onReview, onFork }: {
  message: ChatMessage;
  onReview: (selection: ReviewSelection) => void;
  onFork?: (entryId: number) => void;
}) {
  if (message.role === 'assistant' && !message.blocks.length && !message.error) return null;
  return (
    <article className={`chat-entry chat-entry--${message.role}`} aria-label={message.role === 'user' ? 'You' : 'Pideck'} data-message-id={message.id}>
      {message.role === 'assistant' && <span className="message-avatar"><Icon name="mark" /></span>}
      <div className="message-content">
        {message.blocks.map((block, index) => {
          switch (block.type) {
            case 'text':
              return message.role === 'user'
                ? <div key={index}>{block.text}</div>
                : <Markdown key={index} text={block.text} />;
            case 'thinking':
              return block.text && <details className="thinking" key={index}><summary>Thinking</summary><pre>{block.text}</pre></details>;
            case 'image':
              return <ImageBlock image={block} alt="Attached image" key={index} />;
            case 'tool':
              return <ToolCard block={block} onReview={onReview} key={block.id} />;
          }
        })}
        {message.error && <div className="dialog-error">{message.error}</div>}
      </div>
      {onFork && message.entryId !== undefined && <button type="button" className="icon-button message-fork"
        aria-label="Fork here" title="Fork from this message" onClick={() => onFork(message.entryId!)}><Icon name="fork" width={14} height={14} /></button>}
    </article>
  );
});

export function EmptyScene({ icon, title, children }: {
  icon: 'mark' | 'folderPlus' | 'lock' | 'chat';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-scene">
      <section className="empty-card">
        <div className="hero-mark"><Icon name={icon} /></div>
        <h1>{title}</h1>
        {children}
      </section>
    </div>
  );
}

async function readAttachment(file: File): Promise<Attachment> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.onload = () => {
      const data = String(reader.result).split(',')[1];
      if (!data) reject(new Error('The image is empty.'));
      else resolve({ data, mimeType: file.type as ImageInput['mimeType'], name: file.name });
    };
    reader.readAsDataURL(file);
  });
}

type Delivery = NonNullable<SendChat['delivery']>;

function SessionActions({ busy, available, onCompact, onFork }: {
  busy: boolean;
  available: boolean;
  onCompact: () => void;
  onFork?: () => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  function choose(action: () => void) {
    if (disclosure.current) {
      disclosure.current.open = false;
      disclosure.current.querySelector('summary')?.focus();
    }
    action();
  }
  return <div className="session-tools">
    <details ref={disclosure} className="session-actions"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}>
      <summary className="icon-button" title="Session actions" aria-label="Session actions"><Icon name="more" /></summary>
      <div className="session-actions-list">
        <button type="button" disabled={!available || !onFork} onClick={() => onFork && choose(onFork)}>
          <Icon name="fork" /> Fork from latest turn
        </button>
        <button type="button" disabled={!available || busy} onClick={() => choose(onCompact)}>
          <Icon name="layers" /> Compact context…
        </button>
      </div>
    </details>
  </div>;
}

function CompactDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (instructions: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [instructions, setInstructions] = useState('');
  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    dialog.current?.querySelector('textarea')?.focus();
  }, []);

  function close() {
    dialog.current?.close();
    onClose();
  }

  return <dialog className="settings-dialog" ref={dialog} aria-labelledby="compact-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="dialog-heading"><h2 id="compact-title">Compact context</h2>
      <button type="button" className="icon-button" aria-label="Close compaction" onClick={close}><Icon name="close" /></button>
    </div>
    <p className="dialog-copy">Summarize earlier turns to make room in the model’s context. The conversation history stays available.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      dialog.current?.close();
      onConfirm(instructions.trim());
    }}>
      <div className="settings-fields"><label>What should the summary preserve? (optional)
        <textarea rows={3} maxLength={4000} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </label></div>
      <div className="dialog-actions"><button type="button" className="button" onClick={close}>Cancel</button>
        <button type="submit" className="button button--primary"><Icon name="layers" /> Compact context</button></div>
    </form>
  </dialog>;
}

const starter = 'Inspect this project and explain its structure, entry points, and how to run the tests.';

type HistoryAnchor = { id?: string; top: number; view: ChatView; gap?: ChatGap };

function sameGap(left: ChatGap, right: ChatGap) {
  return left.after === right.after && left.upTo === right.upTo;
}

function completeAttempt(draft: Draft, attempt: SendAttempt): Draft {
  if (draft.attempt?.input.requestId !== attempt.input.requestId) return draft;
  const unchanged = draft.text === attempt.text && draft.attachments === attempt.attachments;
  return {
    ...draft,
    text: unchanged ? '' : draft.text,
    attachments: unchanged ? [] : draft.attachments,
    attempt: undefined,
    sending: false,
    error: undefined,
  };
}

export function Chat({ project, session, models, modelsReady, modelsError, defaultModel, draft, updateDraft,
  onModelChosen, onSettings, onRetryModels, onReview, onWorkspaceChange, onSent, onFork }: {
  project: Project;
  session: Session;
  models: ModelOption[];
  modelsReady: boolean;
  modelsError?: string;
  defaultModel?: string;
  draft: Draft;
  updateDraft: (update: (draft: Draft) => Draft) => void;
  onModelChosen: (key: string) => void;
  onSettings: (provider?: string) => void;
  onRetryModels: () => void;
  onReview: (selection: ReviewSelection) => void;
  onWorkspaceChange: () => void;
  onSent: () => void;
  onFork: (entryId: number) => Promise<void>;
}) {
  const selection = { projectId: project.id, sessionId: session.id };
  const { view, connected, error: connectionError, retry, loadEarlier } = useConversation(selection);
  const [picker, setPicker] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [compactDialog, setCompactDialog] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [delivery, setDelivery] = useState<Delivery>('follow-up');
  const [stopping, setStopping] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [forking, setForking] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const toolStates = useRef<Map<string, string> | undefined>(undefined);
  const geometry = useRef<{ height: number; viewport: number } | undefined>(undefined);
  const { text, attachments } = draft;

  const hasMessages = Boolean(view?.messages.length || view?.hasEarlier || view?.gaps?.length);
  const busy = view?.status === 'running' || view?.status === 'cancelling';
  const agentCompacting = compacting || view?.activity?.kind === 'compacting';
  const activeKey = view?.model && modelKey(view.model);
  const desiredModel = busy ? activeKey : draft.model || activeKey || defaultModel;
  const model = desiredModel
    ? models.find((option) => modelKey(option) === desiredModel)
    : models.find((option) => option.configured);
  const desiredProvider = model?.provider ?? desiredModel?.split('/')[0];
  const modelName = model?.name ?? (desiredModel ? desiredModel.slice(desiredModel.indexOf('/') + 1) : undefined);
  const setupRequired = !busy && modelsReady && !models.some((option) => option.configured);
  const desiredThinking = busy ? view?.thinking : draft.thinking ?? (model && modelKey(model) === activeKey ? view?.thinking : undefined);
  const thinking = desiredThinking && model?.thinking.includes(desiredThinking) ? desiredThinking
    : model?.thinking.includes('off') ? 'off' : model?.thinking[0] ?? 'off';
  const canSend = connected && !agentCompacting && !stopping && !draft.sending && !draft.reading
    && view?.status !== 'cancelling' && Boolean(model?.configured)
    && Boolean(text.trim() || attachments.length) && (!attachments.length || Boolean(model?.supportsImages));
  const latestFork = view?.messages.findLast(({ entryId }) => entryId !== undefined)?.entryId;
  const gaps = view?.gaps ?? [];

  useLayoutEffect(() => {
    setActionsSlot(document.getElementById('session-actions-slot'));
  }, []);

  useEffect(() => {
    if (!connected || (!busy && !agentCompacting)) setStopping(false);
  }, [agentCompacting, busy, connected]);

  function update(patch: Partial<Draft>) {
    updateDraft((current) => ({ ...current, ...patch }));
  }

  function jumpToLatest() {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    pinned.current = true;
    setJumpVisible(false);
  }

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const anchor = historyAnchor.current;
    if (anchor && view && view !== anchor.view) {
      const gap = anchor.gap;
      const changed = gap ? !view.gaps?.some((item) => sameGap(item, gap))
        : view.messages[0]?.id !== anchor.view.messages[0]?.id || !view.hasEarlier;
      if (changed) {
        historyAnchor.current = undefined;
        const entry = anchor.id && element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
        if (entry) element.scrollTop += entry.getBoundingClientRect().top - anchor.top;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        setJumpVisible(!pinned.current);
        return;
      }
    }
    if (!readingHistory && anchor && view === anchor.view) historyAnchor.current = undefined;
    if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [readingHistory, view]);

  useLayoutEffect(() => {
    if (!scroll.current || !thread.current) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current && !historyAnchor.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(thread.current);
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [hasMessages]);

  useEffect(() => {
    if (!draft.attempt || !view) return;
    const attempt = draft.attempt;
    const id = attempt.input.requestId;
    if (view.messages.some((message) => message.requestId === id) || view.queued?.some((queued) => queued.requestId === id)) {
      updateDraft((current) => completeAttempt(current, attempt));
    }
  }, [draft.attempt, updateDraft, view]);

  useEffect(() => {
    if (!view || !connected) return;
    const last = toolStates.current;
    const next = new Map(view.messages.flatMap(({ blocks }) => blocks.flatMap((block) =>
      block.type === 'tool' && ['edit', 'write', 'bash'].includes(block.name)
        ? [[block.id, block.status] as const] : [],
    )));
    if (last && [...next].some(([id, status]) => (status === 'done' || status === 'error') && last.get(id) !== status)) onWorkspaceChange();
    toolStates.current = next;
  }, [connected, onWorkspaceChange, view]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!canSend || !model) {
      if (text.trim() || attachments.length) {
        if (!connected) update({ error: 'Reconnect before sending. Your draft is still here.' });
        else if (modelsReady && !model?.configured) update({ error: modelName
          ? 'The selected model is unavailable. Check its provider or choose another model.'
          : 'Connect a model provider to send this draft.' });
        else if (attachments.length && !model?.supportsImages) update({ error: 'Choose a model that accepts images or remove the attachments.' });
      }
      return;
    }
    const deliveryMode = busy ? delivery : 'send';
    const previous = draft.attempt;
    const requestId = previous?.text === text && previous.attachments === attachments
      ? previous.input.requestId : crypto.randomUUID();
    const attempt: SendAttempt = {
      text, attachments,
      input: {
        ...selection,
        requestId,
        text,
        model: { provider: model.provider, id: model.id },
        thinking,
        delivery: deliveryMode,
        images: attachments.length ? attachments.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
      },
    };
    update({ attempt, sending: true, error: undefined });
    try {
      await window.pideck.invoke('chat:send', attempt.input);
      updateDraft((current) => completeAttempt(current, attempt));
      setDelivery('follow-up');
      jumpToLatest();
      onSent();
    } catch (error) {
      updateDraft((current) => current.attempt?.input.requestId === attempt.input.requestId
        ? { ...current, sending: false, error: readableError(error) }
        : current);
    }
  }

  async function cancel() {
    setStopping(true);
    update({ error: undefined });
    try {
      await window.pideck.invoke('chat:cancel', selection);
    } catch (error) {
      update({ error: readableError(error) });
      setStopping(false);
    }
  }

  async function addFiles(files: File[]) {
    if (draft.reading || !files.length) return;
    const existingSize = attachments.reduce((sum, file) => sum + file.data.length, 0);
    const additionalSize = files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
    if (files.length + attachments.length > 4 || additionalSize + existingSize > 12_000_000) {
      update({ error: 'Attach up to four images with a combined size of 9 MB.' });
      return;
    }
    update({ reading: true, error: undefined });
    try {
      const newAttachments = await Promise.all(files.map(readAttachment));
      updateDraft((current) => ({ ...current, attachments: [...current.attachments, ...newAttachments], reading: false }));
    } catch (error) {
      update({ reading: false, error: readableError(error) });
    }
  }

  async function showEarlier(gap?: ChatGap) {
    const element = scroll.current;
    if (!element || !view || readingHistory) return;
    const edge = element.getBoundingClientRect().top;
    const visible = [...element.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((entry) => entry.getBoundingClientRect().bottom > edge);
    historyAnchor.current = { id: visible?.dataset.messageId, top: visible?.getBoundingClientRect().top ?? 0, view, gap };
    pinned.current = false;
    setReadingHistory(true);
    setHistoryError(undefined);
    try {
      await loadEarlier(gap);
    } catch (error) {
      historyAnchor.current = undefined;
      setHistoryError(readableError(error));
    } finally {
      setReadingHistory(false);
    }
  }

  async function compact(instructions: string) {
    setCompactDialog(false);
    setCompacting(true);
    setNotice(undefined);
    update({ error: undefined });
    try {
      const result = await window.pideck.invoke('chat:compact', { ...selection, instructions: instructions || undefined });
      if (result === 'failed') update({ error: 'Context compaction failed. Your conversation history is still available.' });
      else setNotice({
        compacted: 'Context compacted.',
        'no-change': 'There is no earlier context to compact yet.',
        stopped: 'Context compaction stopped.',
      }[result]);
    } catch (error) {
      update({ error: readableError(error) });
    } finally {
      setCompacting(false);
    }
  }

  const fork = useCallback(async (entryId: number) => {
    if (!connected || forking) return;
    setForking(true);
    try {
      await onFork(entryId);
    } catch (error) {
      updateDraft((current) => ({ ...current, error: readableError(error) }));
    } finally {
      setForking(false);
    }
  }, [connected, forking, onFork, updateDraft]);

  function renderGaps(beforeMessageId?: string) {
    return gaps.filter((gap) => gap.beforeMessageId === beforeMessageId).map((gap) => (
      <button key={`${gap.after}:${gap.upTo}`} className="button history-button" type="button"
        disabled={!connected || readingHistory} onClick={() => void showEarlier(gap)}>Load messages here</button>
    ));
  }

  const retryTime = view?.activity?.kind === 'retrying' && view.activity.retryAt
    ? new Date(view.activity.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : undefined;
  const runStatus = stopping || view?.status === 'cancelling' ? 'Stopping…'
    : agentCompacting ? 'Compacting context…'
    : view?.activity?.kind === 'retrying' ? retryTime ? `Model retry scheduled for ${retryTime}` : 'Retrying the model…'
    : view?.activity?.kind === 'waiting' ? 'Waiting for the provider…'
    : busy ? 'Pideck is working' : undefined;
  const composerStatus = draft.sending ? 'Sending…'
    : draft.reading ? 'Attaching images…'
    : attachments.length > 0 && model && !model.supportsImages ? 'Choose a model that accepts images.'
    : setupRequired && modelName ? `${modelName} is unavailable.`
    : !busy && modelsReady && !setupRequired && modelName && !model?.configured
      ? <><span>Selected model unavailable</span><button className="inline-action" type="button"
        onClick={() => onSettings(desiredProvider)}>Provider settings</button></>
      : busy && !agentCompacting && delivery === 'steer' ? 'Steer sends guidance to the current run.' : undefined;
  const submitLabel = busy && !agentCompacting ? delivery === 'steer' ? 'Steer the run' : 'Queue follow-up' : 'Send';

  return (
    <main className="chat" aria-label="Conversation">
      {actionsSlot && hasMessages && createPortal(
        <SessionActions busy={busy || agentCompacting} available={connected && !forking}
          onCompact={() => setCompactDialog(true)} onFork={latestFork !== undefined ? () => void fork(latestFork) : undefined} />,
        actionsSlot,
      )}
      {!connected && (
        <div className={`notice ${connectionError ? '' : 'notice--info'}`} role={connectionError ? 'alert' : 'status'}>
          <Icon name={connectionError ? 'alert' : 'chat'} />
          <span>{connectionError ?? (view ? 'Reconnecting to the session…' : 'Opening the session…')}</span>
          {connectionError && <button className="button" type="button" onClick={retry}>Reconnect</button>}
        </div>
      )}
      <div className={`chat-scroll ${hasMessages || view?.error || runStatus ? '' : 'chat-scroll--empty'}`} ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          const previous = geometry.current;
          geometry.current = { height: element.scrollHeight, viewport: element.clientHeight };
          if (pinned.current && previous && (previous.height !== element.scrollHeight || previous.viewport !== element.clientHeight)) {
            element.scrollTop = element.scrollHeight;
          } else {
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          }
          setJumpVisible(!pinned.current);
        }}>
        {hasMessages || view?.error || runStatus ? (
          <div className="chat-thread" ref={thread}>
            {view?.hasEarlier && <button className="button history-button" type="button" disabled={!connected || readingHistory}
              onClick={() => void showEarlier()}>{readingHistory ? 'Loading history…' : 'Load earlier messages'}</button>}
            {historyError && <div className="notice" role="alert"><Icon name="alert" /><span>{historyError}</span></div>}
            {view?.messages.map((message) => (
              <div className={`chat-turn chat-turn--${message.role}`} key={message.id}>
                {renderGaps(message.id)}
                <Message message={message} onReview={onReview} onFork={connected && !forking ? fork : undefined} />
              </div>
            ))}
            {renderGaps()}
            {runStatus && <div className="run-state" role="status"><span className="run-state-dot" />{runStatus}</div>}
            {view?.error && <div className="notice" role="alert"><Icon name="alert" /><span>{view.error}</span></div>}
          </div>
        ) : (
          <div className="chat-welcome">
            <div className="chat-welcome-content">
              <Icon className="chat-welcome-mark" name="mark" width={26} height={26} />
              <h1>What are we building?</h1>
              <p>{setupRequired ? 'Connect a model provider to start working in this project.' : 'Ask about the codebase or describe a change.'}</p>
              {model?.configured && <button type="button" className="button chat-starter" disabled={Boolean(text.trim())}
                onClick={() => { update({ text: starter, error: undefined }); textarea.current?.focus(); }}>
                <Icon name="code" width={14} height={14} /> Explore this project
              </button>}
            </div>
          </div>
        )}
      </div>
      {jumpVisible && <div className="chat-jump-anchor"><button className="chat-jump" type="button" onClick={jumpToLatest}><Icon name="arrowDown" /> Latest</button></div>}
      <div className="composer-wrap">
        {view?.queued?.length ? <div className="queued-list" aria-label="Queued messages">
          {view.queued.map((item) => <div key={item.id}><span>{item.delivery === 'steer' ? 'Steer' : 'Follow-up'}</span><span title={item.preview}>{item.preview}</span></div>)}
        </div> : null}
        {(draft.error || modelsError || notice) && <div className={`notice composer-notice ${draft.error || modelsError ? '' : 'notice--info'}`}
          role={draft.error || modelsError ? 'alert' : 'status'}>
          <Icon name={draft.error || modelsError ? 'alert' : 'check'} /><span>{draft.error ?? modelsError ?? notice}</span>
          {modelsError && !draft.error
            ? <button className="inline-action" type="button" onClick={onRetryModels}>Retry models</button>
            : <button className="icon-button" type="button" aria-label="Dismiss chat notice" onClick={() => {
              update({ error: undefined }); setNotice(undefined);
            }}><Icon name="close" /></button>}
        </div>}
        <form className="composer" ref={form} onSubmit={send}>
          {attachments.length > 0 && <div className="attachments">
            {attachments.map((attachment, index) => (
              <div className="attachment" key={index} title={attachment.name}>
                <img src={imageSource(attachment)} alt="" />
                <span>{attachment.name}</span>
                <button className="icon-button" type="button" aria-label={`Remove ${attachment.name}`}
                  onClick={() => updateDraft((current) => ({ ...current, attachments: current.attachments.filter((item) => item !== attachment) }))}><Icon name="close" width={13} height={13} /></button>
              </div>
            ))}
          </div>}
          <textarea ref={textarea} id="prompt" value={text} maxLength={200000} rows={2} aria-label="Message Pideck"
            placeholder={busy && !agentCompacting ? 'Draft a follow-up or steer the current run…' : 'Message Pideck…'}
            onChange={(event) => update({ text: event.target.value, error: undefined })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (images.length) {
                if (model?.supportsImages) {
                  event.preventDefault();
                  void addFiles(images);
                } else if (!event.clipboardData.getData('text/plain')) {
                  update({ error: 'Choose a model that accepts images to paste a screenshot.' });
                }
              }
            }} />
          <div className="composer-controls">
            <div className="composer-models">
              {setupRequired
                ? <button className="button provider-setup-trigger" type="button" onClick={() => onSettings(desiredProvider)}>
                    <Icon name="key" width={14} height={14} /> Connect a provider
                  </button>
                : <button className="model-trigger" type="button" aria-label="Model" aria-haspopup="dialog"
                    disabled={!models.length || busy}
                    title={modelName ? `${desiredProvider ? providerLabel(desiredProvider) + ' · ' : ''}${modelName}` : 'Choose a model'}
                    onClick={() => setPicker(true)}>
                    <span>{modelName ?? (modelsReady ? 'Choose model' : 'Loading models…')}</span>
                    {!busy && <Icon name="down" width={12} height={12} />}
                  </button>}
              {model && model.thinking.length > 1 && !busy && <div className="select-shell thinking-select">
                <select aria-label="Thinking level" title="Thinking level" value={thinking}
                  onChange={(event) => update({ thinking: event.target.value as Thinking })}>
                  {model.thinking.map((level) => <option key={level} value={level}>Thinking · {thinkingLabels[level]}</option>)}
                </select>
                <Icon name="down" width={12} height={12} />
              </div>}
            </div>
            <div className="composer-actions">
              {busy && !agentCompacting && <div className="select-shell delivery-select">
                <select aria-label="Message delivery" value={delivery} onChange={(event) => setDelivery(event.target.value as Delivery)}>
                  <option value="follow-up">Follow-up</option><option value="steer">Steer</option>
                </select><Icon name="down" width={12} height={12} />
              </div>}
              {model?.supportsImages && <>
                <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple ref={fileInput}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void addFiles(files);
                  }} />
                <button className="icon-button" type="button" title="Attach images" aria-label="Attach images"
                  disabled={draft.reading || attachments.length >= 4} onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
              </>}
              {(busy || agentCompacting) && <button className="button send-button stop-button" type="button" onClick={cancel}
                title={agentCompacting ? 'Stop compaction' : 'Stop the run'} aria-label={agentCompacting ? 'Stop compaction' : 'Stop the run'}
                disabled={!connected || stopping || view?.status === 'cancelling'}><Icon name="stop" /></button>}
              <button className="button button--primary send-button" type="submit" title={`${submitLabel} (Enter)`} aria-label={submitLabel}
                disabled={!canSend}><Icon name="arrowUp" /></button>
            </div>
          </div>
        </form>
        {composerStatus && <div className="composer-status" role="status">{composerStatus}</div>}
      </div>
      {picker && <ModelPicker models={models} selected={model} onClose={() => setPicker(false)} onChoose={(option) => {
        const key = modelKey(option);
        update({ model: key, thinking: undefined, error: undefined });
        if (option.configured) onModelChosen(key);
        setPicker(false);
        if (!option.configured) onSettings(option.provider);
        else textarea.current?.focus();
      }} />}
      {compactDialog && <CompactDialog onClose={() => setCompactDialog(false)} onConfirm={compact} />}
    </main>
  );
}
