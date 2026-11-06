import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatBlock, ChatGap, ChatMessage, ChatView, ImageInput, ModelOption, Project, Session, SessionActivity, StartChat, Thinking } from '../shared/api';
import { Icon } from './Icons';
import { readableError, useConversation } from './conversation';
import { ModelPicker, modelKey, providerLabel } from './ModelPicker';
import { QueuedMessages } from './QueuedMessages';
import { useReadSessionActivity } from './session-activity';
import type { Attachment, Draft, ReadingPosition, SendAttempt } from './preferences';
import { completeAttempt } from './preferences';
import './chat.css';

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
  const shell = block.name === 'bash';
  const showReview = (block.name === 'edit' || block.name === 'write') && path && block.status === 'done';
  const status = { pending: 'Queued', running: 'Running', done: shell ? 'Succeeded' : undefined, error: 'Failed' }[block.status];
  const longCommand = typeof command === 'string' && (command.includes('\n') || command.length > 48);
  const disclosureMode = shell ? block.status : 'default';
  const [disclosure, setDisclosure] = useState<{ mode: typeof disclosureMode; open: boolean }>();
  const defaultOpen = Boolean(block.patch) || block.status === 'error' || (shell && block.status !== 'done');
  const open = disclosure?.mode === disclosureMode ? disclosure.open : defaultOpen;

  return (
    <details className="tool-card" open={open}>
      <summary title={target} onClick={(event) => {
        event.preventDefault();
        setDisclosure({ mode: disclosureMode, open: !open });
      }}>
        <Icon name={shell ? 'terminal' : 'file'} />
        {(!shell || !target) && <span className="tool-label">{toolLabels[block.name] ?? block.name}</span>}
        {target && <span className="tool-target">{target}</span>}
        {status && <span className="tool-state" data-status={block.status}>{status}</span>}
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
                onClick={() => onReview({ path })}>Open review <span aria-hidden="true">↗</span></button>}
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
  const author = message.role === 'user' ? 'You' : 'Pideck';
  const entryId = message.entryId;
  const readingEntry = entryId ?? /^(\d+):\d+$/.exec(message.id)?.[1];
  return (
    <article className={`chat-entry chat-entry--${message.role}`} aria-label={author} data-message-id={message.id}
      data-reading-entry={readingEntry}>
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
      {onFork && entryId !== undefined && <button type="button" className="icon-button message-fork"
        onClick={() => onFork(entryId)} title="Start a new session from this message" aria-label="Branch from here">
        <Icon name="fork" width={14} height={14} />
      </button>}
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
        <div className="hero-mark" data-icon={icon}><Icon name={icon} /></div>
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

type HistoryAnchor = { id?: string; top: number; view: ChatView; gap?: ChatGap };

function visibleReadingPosition(element: HTMLElement): ReadingPosition | undefined {
  const edge = element.getBoundingClientRect().top;
  const entries = element.querySelectorAll<HTMLElement>('[data-reading-entry]');
  let start = 0;
  let end = entries.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (entries[middle]!.getBoundingClientRect().bottom <= edge) start = middle + 1;
    else end = middle;
  }
  const entry = entries[start];
  const messageId = entry?.dataset.messageId;
  const entryId = Number(entry?.dataset.readingEntry);
  if (entry && messageId && Number.isSafeInteger(entryId) && entryId > 0) {
    const top = entry.getBoundingClientRect().top;
    if (top < edge + element.clientHeight) return { messageId, entryId, offset: Math.round(top - edge) };
  }
}

function sameGap(left: ChatGap, right: ChatGap) {
  return left.after === right.after && left.upTo === right.upTo;
}

export function Chat({ project, session, activityReceipt, models, modelsReady, modelsError, defaultModel, draft, updateDraft, readingPosition, onReadingPosition,
  onModelChosen, onSettings, onRetryModels, onReview, onWorkspaceChange, onSent, onStarted, onFork }: {
  project: Project;
  session?: Session;
  activityReceipt?: SessionActivity;
  models: ModelOption[];
  modelsReady: boolean;
  modelsError?: string;
  defaultModel?: string;
  draft: Draft;
  updateDraft: (update: (draft: Draft) => Draft) => void;
  readingPosition?: ReadingPosition;
  onReadingPosition: (position: ReadingPosition | undefined) => void;
  onModelChosen: (key: string) => void;
  onSettings: (provider?: string) => void;
  onRetryModels: () => void;
  onReview: (selection: ReviewSelection) => void;
  onWorkspaceChange: () => void;
  onSent: () => void;
  onStarted: (session: Session) => void;
  onFork: (entryId: number) => Promise<void>;
}) {
  const selection = session ? { projectId: project.id, sessionId: session.id } : undefined;
  const currentPosition = useRef(readingPosition);
  const lastWatch = useRef<string | undefined>(undefined);
  const { view, watchId, connected: watchConnected, error: connectionError, retry, loadEarlier } =
    useConversation({ projectId: project.id, sessionId: session?.id }, currentPosition);
  const connected = !session || watchConnected;
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
  const pinned = useRef(!readingPosition);
  const historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const toolStates = useRef<Map<string, string> | undefined>(undefined);
  const geometry = useRef<{ height: number; viewport: number } | undefined>(undefined);
  useReadSessionActivity(watchConnected ? activityReceipt : undefined, view, scroll);
  const { text, attachments } = draft;

  const hasMessages = Boolean(view?.messages.length || view?.hasEarlier || view?.gaps?.length);
  const busy = view?.status === 'running' || view?.status === 'cancelling';
  const agentCompacting = view?.activity?.kind === 'compacting';
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
  const hasDraft = Boolean(text.trim() || attachments.length);
  const startingSession = !session && draft.sending;
  const empty = connected && !hasMessages && !view?.error && !busy && !agentCompacting;
  const canSend = connected && !agentCompacting && !stopping && !draft.sending && !draft.reading
    && view?.status !== 'cancelling' && Boolean(model?.configured)
    && hasDraft && (!attachments.length || Boolean(model?.supportsImages));
  const gaps = view?.gaps ?? [];

  useEffect(() => {
    if (!connected || (!busy && !agentCompacting)) setStopping(false);
  }, [agentCompacting, busy, connected]);

  function update(patch: Partial<Draft>) {
    updateDraft((current) => ({ ...current, ...patch }));
  }

  function jumpToLatest() {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    currentPosition.current = undefined;
    onReadingPosition(undefined);
    setJumpVisible(false);
  }

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (watchId && lastWatch.current !== watchId) {
      lastWatch.current = watchId;
      const saved = currentPosition.current;
      if (saved) {
        const entry = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.messageId)}"]`);
        if (entry) {
          const bounds = entry.getBoundingClientRect();
          const offset = Math.max(saved.offset, 1 - bounds.height);
          element.scrollTop += bounds.top - element.getBoundingClientRect().top - offset;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          setJumpVisible(!pinned.current);
          return;
        }
        currentPosition.current = undefined;
        onReadingPosition(undefined);
        pinned.current = true;
      }
    }
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
  }, [onReadingPosition, readingHistory, view, watchId]);

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
    const attempt = draft.attempt;
    const id = attempt?.requestId ?? draft.pendingRequestId;
    if (!id || !view) return;
    if (view.messages.some((message) => message.requestId === id) || view.queued?.some((queued) => queued.requestId === id)) {
      updateDraft((current) => attempt ? completeAttempt(current, attempt)
        : current.pendingRequestId === id ? { ...current, text: '', pendingRequestId: undefined } : current);
    }
  }, [draft.attempt, draft.pendingRequestId, updateDraft, view]);

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

  async function send() {
    if (!canSend || !model) return;
    const previous = draft.attempt;
    const requestId = previous?.text === text && previous.attachments === attachments
      ? previous.requestId : draft.pendingRequestId ?? crypto.randomUUID();
    const attempt: SendAttempt = { text, attachments, requestId };
    const input: StartChat = {
      projectId: project.id, requestId, text, model: { provider: model.provider, id: model.id }, thinking,
      images: attachments.length ? attachments.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    };
    update({ attempt, sending: true, error: undefined });
    textarea.current?.focus({ preventScroll: true });
    try {
      if (selection) {
        await window.pideck.invoke('chat:send', { ...input, ...selection, delivery: busy ? 'follow-up' : 'send' });
        updateDraft((current) => completeAttempt(current, attempt));
        jumpToLatest();
        onSent();
      } else {
        const started = await window.pideck.invoke('chat:start', input);
        onStarted(started);
      }
    } catch (error) {
      updateDraft((current) => current.attempt?.requestId === attempt.requestId
        ? { ...current, sending: false, error: readableError(error) }
        : current);
    }
  }

  async function cancel() {
    if (!selection) return;
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
    if (draft.reading || startingSession || !files.length) return;
    const existingSize = attachments.reduce((sum, file) => sum + file.data.length, 0);
    const additionalSize = files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
    if (files.length + attachments.length > 4 || additionalSize + existingSize > 12_000_000) {
      update({ error: 'Attach up to four images with a combined size of 9 MB.' });
      return;
    }
    update({ reading: true, error: undefined });
    try {
      const newAttachments = await Promise.all(files.map(readAttachment));
      updateDraft((current) => ({ ...current, attachments: [...current.attachments, ...newAttachments], pendingRequestId: undefined, reading: false }));
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
    : agentCompacting ? 'Summarizing context…'
    : view?.activity?.kind === 'retrying' ? retryTime ? `Model retry scheduled for ${retryTime}` : 'Retrying the model…'
    : view?.activity?.kind === 'waiting' ? 'Waiting for the provider…'
    : busy ? 'Pideck is working' : undefined;
  const composerStatus = draft.sending ? 'Sending…'
    : draft.reading ? 'Attaching images…'
    : attachments.length > 0 && model && !model.supportsImages ? 'Choose a model that accepts images.'
    : !busy && modelsReady && !setupRequired && modelName && !model?.configured
      ? <><span>Selected model unavailable</span><button className="inline-action" type="button"
        onClick={() => onSettings(desiredProvider)}>Connect {desiredProvider ? providerLabel(desiredProvider) : 'provider'}</button></>
      : undefined;
  const queueing = busy && !agentCompacting;
  const submitLabel = queueing ? 'Queue next' : 'Send';
  const thinkingOptions = model?.configured && model.thinking.length > 1 ? { level: thinking, labels: thinkingLabels } : undefined;
  const displayedThinking = busy ? view?.thinking ?? (activeKey ? 'off' : undefined) : model?.configured ? thinking : undefined;
  const thinkingLabel = displayedThinking && thinkingLabels[displayedThinking];
  const modelLabel = <span className="model-summary">
    <span className="model-summary-name">{modelName ?? 'Choose a model'}</span>
    {thinkingLabel && <span className="model-summary-thinking">{thinkingLabel}</span>}
  </span>;
  const modelDescription = modelName
    ? [desiredProvider && providerLabel(desiredProvider), modelName, thinkingLabel && `Thinking ${thinkingLabel.toLowerCase()}`]
      .filter(Boolean).join(' · ')
    : 'Choose a model';

  return (
    <main className={`chat${empty ? ' chat--empty' : ''}`} aria-label="Conversation">
      {!connected && (
        <div className={`notice ${connectionError ? '' : 'notice--info'}`} role={connectionError ? 'alert' : 'status'}>
          <Icon name={connectionError ? 'alert' : 'chat'} />
          <span>{connectionError ?? (view ? 'Reconnecting to the session…' : 'Opening the session…')}</span>
          {connectionError && <button className="button" type="button" onClick={retry}>Reconnect</button>}
        </div>
      )}
      <div className={`chat-scroll${empty ? ' chat-scroll--empty' : ''}`} ref={scroll}
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
          if (!watchId || historyAnchor.current) return;
          const position = pinned.current ? undefined : visibleReadingPosition(element);
          if (pinned.current || position) {
            currentPosition.current = position;
            onReadingPosition(position);
          }
        }}>
        {empty ? (
          <div className="chat-welcome">
            <h1>What would you like to work on?</h1>
            <p>{setupRequired ? 'Connect a model provider to send your first message.' : 'Ask about the codebase or describe a change.'}</p>
          </div>
        ) : hasMessages || view?.error ? (
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
            {view?.error && <div className="notice chat-run-error" role="alert"><Icon name="alert" /><span>{view.error}</span></div>}
          </div>
        ) : null}
      </div>
      {jumpVisible && <div className="chat-jump-anchor"><button className="chat-jump" type="button" onClick={jumpToLatest}><Icon name="arrowDown" /> Latest</button></div>}
      <div className="composer-wrap">
        {runStatus && <div className="composer-run">
          <div className="run-state" role="status"><span className="run-state-dot" />{runStatus}</div>
          <button className="composer-stop" type="button" onClick={cancel}
            title={agentCompacting ? 'Stop current work' : 'Stop the run'} aria-label={agentCompacting ? 'Stop current work' : 'Stop the run'}
            disabled={!connected || stopping || view?.status === 'cancelling'}><Icon name="stop" /> Stop</button>
        </div>}
        {selection && <QueuedMessages selection={selection} items={view?.queued} canSteer={Boolean(view?.canSteerQueued)}
          enabled={connected && !stopping && view?.status !== 'cancelling'}
          onFocusComposer={() => textarea.current?.focus({ preventScroll: true })} />}
        {(draft.error || modelsError) && <div className="notice composer-notice" role="alert">
          <Icon name="alert" /><span>{draft.error ?? modelsError}</span>
          {modelsError && !draft.error
            ? <button className="inline-action" type="button" onClick={onRetryModels}>Retry models</button>
            : <button className="icon-button" type="button" aria-label="Dismiss chat notice"
              onClick={() => update({ error: undefined })}><Icon name="close" /></button>}
        </div>}
        <form className="composer" ref={form} onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {attachments.length > 0 && <div className="attachments">
            {attachments.map((attachment, index) => (
              <div className="attachment" key={index} title={attachment.name}>
                <img src={imageSource(attachment)} alt="" />
                <span>{attachment.name}</span>
                <button className="icon-button" type="button" aria-label={`Remove ${attachment.name}`}
                  disabled={startingSession}
                  onClick={() => updateDraft((current) => ({ ...current, attachments: current.attachments.filter((item) => item !== attachment) }))}><Icon name="close" width={13} height={13} /></button>
              </div>
            ))}
          </div>}
          <textarea ref={textarea} id="prompt" value={text} maxLength={200000} rows={2} aria-label="Message Pideck"
            placeholder={queueing ? 'Write a follow-up…' : 'Message Pideck…'}
            onChange={(event) => update({ text: event.target.value, pendingRequestId: undefined, error: undefined })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (images.length) {
                if (model?.configured && model.supportsImages && !startingSession) {
                  event.preventDefault();
                  void addFiles(images);
                } else if (!event.clipboardData.getData('text/plain')) {
                  if (!startingSession) update({ error: 'Choose a model that accepts images to paste a screenshot.' });
                }
              }
            }} />
          <div className="composer-controls">
            <div className="composer-models">
              {model?.configured && model.supportsImages && <>
                <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple ref={fileInput}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void addFiles(files);
                  }} />
                <button className="icon-button composer-attach" type="button" title="Attach images" aria-label="Attach images"
                  disabled={startingSession || draft.reading || attachments.length >= 4}
                  onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
              </>}
              {busy || agentCompacting ? modelName && <span className="composer-current-model" title={modelDescription}>{modelLabel}</span> : setupRequired
                ? <button className="button provider-setup-trigger" type="button" onClick={() => onSettings(desiredProvider)}>
                    <Icon name="key" width={14} height={14} /> Connect a provider
                  </button>
                : models.length > 0 ? <ModelPicker models={models} selected={model} label={modelLabel}
                    description={modelDescription} thinking={thinkingOptions}
                    onThinkingChange={(level) => update({ thinking: level })}
                    onChoose={(option) => {
                      const key = modelKey(option);
                      update({ model: key, thinking: undefined, error: undefined });
                      onModelChosen(key);
                      textarea.current?.focus();
                    }} /> : !modelsError && <span className="composer-current-model">Loading models…</span>}
            </div>
            <div className="composer-actions">
              <button className="button button--primary send-button" type="submit" title={`${submitLabel} (Enter)`} aria-label={submitLabel}
                disabled={!canSend}>{submitLabel}<Icon name="arrowUp" width={14} height={14} /></button>
            </div>
          </div>
        </form>
        {composerStatus && <div className="composer-status" role="status">{composerStatus}</div>}
      </div>
    </main>
  );
}
