import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatBlock, ChatGap, ChatMessage, ChatView, Commands, ImageInput, ModelOption, Project, Selection, Session, SessionActivity, StartChat, Thinking } from '../shared/api';
import { Icon } from './Icons';
import { ImageBlock } from './ChatImage';
import { Message, type ReviewSelection } from './ChatMessage';
import { readableError, useConversation } from './conversation';
import { ModelPicker, modelKey, providerLabel } from './ModelPicker';
import { QueuedMessages } from './QueuedMessages';
import { RunClock } from './RunClock';
import { useReadSessionActivity } from './session-activity';
import type { Attachment, Draft, ReadingPosition, SendAttempt } from './preferences';
import { completeAttempt, hydrateDraftImages, newSessionDraft, persistDraftImages, retainQueueEditText } from './preferences';
import './chat.css';

type ToolBlock = Extract<ChatBlock, { type: 'tool' }>;

const toolPhases: Record<string, string> = {
  read: 'Reading file…', write: 'Writing file…', edit: 'Editing file…', bash: 'Running command…',
};
const thinkingLabels: Record<Thinking, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};

function runPhase(messages: ChatMessage[]): { label: string; detail?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') break;
    const active = message.blocks.findLast((block): block is ToolBlock =>
      block.type === 'tool' && (block.status === 'pending' || block.status === 'running'));
    if (active) {
      if (active.status === 'pending') return { label: 'Preparing tool…' };
      const detail = active.arguments?.command ?? active.path;
      return {
        label: Object.hasOwn(toolPhases, active.name) ? toolPhases[active.name] : 'Running tool…',
        detail: typeof detail === 'string' ? detail : undefined,
      };
    }
  }
  const latest = messages.at(-1);
  const output = latest?.role === 'assistant' ? latest.blocks.at(-1) : undefined;
  if (output?.type === 'text' && output.text.trim()) return { label: 'Writing response…' };
  if (output?.type === 'thinking') return { label: 'Thinking…' };
  return { label: 'Waiting for the model…' };
}

export function EmptyScene({ icon, title, children }: {
  icon: 'mark' | 'folderPlus' | 'chat';
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

export function Chat({ project, session, activityReceipt, models, modelsReady, modelsError, savedConnectionsPending, defaultModel, draft, updateDraft,
  readingPosition, onReadingPosition, onModelChosen, onSettings, onRetryModels, onLoadSavedModels, onReview, onWorkspaceChange, onSent, onStarted, onFork }: {
  project: Project;
  session?: Session;
  activityReceipt?: SessionActivity;
  models: ModelOption[];
  modelsReady: boolean;
  modelsError?: string;
  savedConnectionsPending: boolean;
  defaultModel?: string;
  draft: Draft;
  updateDraft: (update: (draft: Draft) => Draft) => void;
  readingPosition?: ReadingPosition;
  onReadingPosition: (position: ReadingPosition | undefined) => void;
  onModelChosen: (key: string) => void;
  onSettings: (provider?: string) => void;
  onRetryModels: () => void;
  onLoadSavedModels: () => Promise<ModelOption[]>;
  onReview: (selection: ReviewSelection) => void;
  onWorkspaceChange: () => void;
  onSent: () => void;
  onStarted: (session: Session) => void;
  onFork: (entryId: number) => Promise<void>;
}) {
  const selection = useMemo(() => session ? { projectId: project.id, sessionId: session.id } : undefined, [project.id, session?.id]);
  const currentPosition = useRef(readingPosition);
  const lastWatch = useRef<string | undefined>(undefined);
  const { view, watchId, connected: watchConnected, error: connectionError, retry, loadEarlier } =
    useConversation({ projectId: project.id, sessionId: session?.id }, currentPosition);
  const connected = !session || watchConnected;
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [runControlError, setRunControlError] = useState<string>();
  const runControlPending = useRef<'cancel' | 'continue' | undefined>(undefined);
  const continueRequest = useRef<{ failureTaskId?: number; requestId: string } | undefined>(undefined);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [forking, setForking] = useState(false);
  const [queueSaving, setQueueSaving] = useState(false);
  // Queue images remain in Durable, not the persisted ordinary draft. Reload
  // them with the edit lease on session switches, reopening and watch recovery.
  const [queueContent, setQueueContent] = useState<Commands['chat:queue-edit-start'][1]>();
  const queueReady = queueContent?.token;
  const [queueRetry, setQueueRetry] = useState(0);
  const queueClaim = useRef<string | undefined>(undefined);
  const [toolDisclosure, setToolDisclosure] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const setToolExpanded = useCallback((id: string, expanded: boolean) => {
    setToolDisclosure(current => new Map(current).set(id, expanded));
  }, []);
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const runStateElement = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pinned = useRef(!readingPosition);
  const historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const toolStates = useRef<Map<string, string> | undefined>(undefined);
  const geometry = useRef<{ height: number; viewport: number } | undefined>(undefined);
  useReadSessionActivity(watchConnected ? activityReceipt : undefined, view, scroll, runStateElement);
  const { text, attachments, queueEdit } = draft;

  const hasMessages = Boolean(view?.messages.length || view?.hasEarlier || view?.gaps?.length);
  const busy = view?.status === 'running' || view?.status === 'cancelling';
  const agentCompacting = view?.activity?.kind === 'compacting';
  const activeKey = view?.model && modelKey(view.model);
  const desiredModel = busy ? activeKey : draft.model || activeKey || defaultModel;
  const resolveModel = (catalog: ModelOption[]) => desiredModel
    ? catalog.find((option) => modelKey(option) === desiredModel)
    : catalog.find((option) => option.configured);
  const model = resolveModel(models);
  const desiredProvider = model?.provider ?? desiredModel?.split('/')[0];
  const modelName = model?.name ?? (desiredModel ? desiredModel.slice(desiredModel.indexOf('/') + 1) : undefined);
  const setupRequired = !busy && modelsReady && !savedConnectionsPending && !models.some((option) => option.configured);
  const awaitingSavedModel = savedConnectionsPending && !model?.configured;
  const canAttach = Boolean(model?.configured || awaitingSavedModel) && (model?.supportsImages ?? awaitingSavedModel);
  function resolveThinking(option: ModelOption | undefined): Thinking {
    const preferred = busy ? view?.thinking : draft.thinking ?? (option && modelKey(option) === activeKey ? view?.thinking : undefined);
    if (preferred && option?.thinking.includes(preferred)) return preferred;
    return option?.thinking.includes('off') ? 'off' : option?.thinking[0] ?? 'off';
  }
  const thinking = resolveThinking(model);
  const hasDraft = Boolean(text.trim() || attachments.length);
  const startingSession = !session && draft.sending;
  const empty = connected && !hasMessages && !view?.error && !busy && !agentCompacting;
  const canSend = !queueEdit && connected && !agentCompacting && !stopping && !continuing && !draft.sending && !draft.reading
    && view?.status !== 'cancelling' && Boolean(model?.configured || awaitingSavedModel)
    && hasDraft && !draft.imagesUnavailable && (!attachments.length || canAttach);
  const canSaveQueue = Boolean(selection && queueEdit && connected && !stopping && !continuing && !queueSaving && !draft.sending
    && view?.status !== 'cancelling' && view?.queued?.some(item => item.id === queueEdit.id)
    && queueReady === queueEdit.token && (queueEdit.text.trim() || queueEdit.hasImages));
  const gaps = view?.gaps ?? [];

  useEffect(() => {
    if (runControlPending.current !== 'cancel' && (!connected || (!busy && !agentCompacting))) setStopping(false);
  }, [agentCompacting, busy, connected]);

  useEffect(() => {
    if (busy || !view?.canContinue || view.runOutcome?.taskId !== continueRequest.current?.failureTaskId) setContinuing(false);
    setRunControlError(undefined);
  }, [busy, view?.canContinue, view?.runOutcome?.taskId]);

  const cancelTool = useCallback(async (taskId: number) => {
    if (!session) return;
    await window.pideck.invoke('chat:task-cancel', { projectId: project.id, sessionId: session.id, taskId });
  }, [project.id, session?.id]);

  function update(patch: Partial<Draft>) {
    updateDraft((current) => ({ ...current, ...patch }));
  }

  useLayoutEffect(() => {
    if (queueEdit) textarea.current?.focus({ preventScroll: true });
  }, [queueEdit?.id]);

  useEffect(() => {
    if (!queueEdit || queueSaving || !watchConnected || !view || view.queued?.some(item => item.id === queueEdit.id)) return;
    updateDraft(retainQueueEditText);
  }, [queueEdit, queueSaving, updateDraft, view, watchConnected]);

  useEffect(() => {
    if (!queueEdit || !session || !watchConnected) {
      setQueueContent(undefined);
      queueClaim.current = undefined;
      return;
    }
    const edit = queueEdit;
    const claim = `${watchId}/${edit.token}`;
    if (queueClaim.current === claim) return;
    let active = true;
    setQueueContent(undefined);
    void window.pideck.invoke('chat:queue-edit-start', {
      projectId: project.id, sessionId: session.id, id: edit.id, token: edit.token,
    }).then(content => {
      if (!active) return;
      const { token, text, images } = content;
      const hasImages = images.length > 0;
      queueClaim.current = `${watchId}/${token}`;
      setQueueContent(content);
      updateDraft(current => current.queueEdit?.token === edit.token
        ? { ...current, error: undefined, queueEdit: current.queueEdit.loading
          ? { id: edit.id, token, text, original: text, hasImages }
          : { ...current.queueEdit, token, hasImages } } : current);
    }, cause => {
      if (active) updateDraft(current => current.queueEdit?.token === edit.token
        ? { ...current, error: readableError(cause) } : current);
    });
    return () => { active = false; };
  }, [project.id, queueEdit?.id, queueEdit?.token, queueRetry, session?.id, updateDraft, watchConnected, watchId]);

  function editQueuedMessage(id: number) {
    queueClaim.current = undefined;
    setQueueContent(undefined);
    // App persists this intent in its layout effect before the lease effect runs.
    // A close or lost reply can then reconnect the exact reservation on reopening.
    updateDraft(current => current.queueEdit ? current : { ...current,
      queueEdit: { id, token: crypto.randomUUID(), text: '', original: '', hasImages: false, loading: true }, error: undefined });
  }

  async function cancelQueueEdit() {
    const edit = queueEdit;
    if (!edit || !selection || queueSaving || queueReady !== edit.token) return;
    setQueueSaving(true);
    update({ error: undefined });
    try {
      await window.pideck.invoke('chat:queue-edit-finish', { ...selection, id: edit.id, token: edit.token });
      updateDraft(current => current.queueEdit?.token === edit.token ? { ...current, queueEdit: undefined, error: undefined } : current);
    } catch (cause) {
      updateDraft(current => current.queueEdit?.token === edit.token ? { ...current, error: readableError(cause) } : current);
    } finally {
      setQueueSaving(false);
      textarea.current?.focus({ preventScroll: true });
    }
  }

  async function saveQueueEdit() {
    const edit = queueEdit;
    if (!edit || !selection || !canSaveQueue) return;
    setQueueSaving(true);
    update({ error: undefined });
    try {
      await window.pideck.invoke('chat:queue-edit-finish', { ...selection, id: edit.id, token: edit.token, text: edit.text });
      updateDraft(current => current.queueEdit?.token === edit.token ? { ...current, queueEdit: undefined, error: undefined } : current);
    } catch (cause) {
      updateDraft(current => current.queueEdit?.token === edit.token ? { ...current, error: readableError(cause) } : current);
    } finally {
      setQueueSaving(false);
      textarea.current?.focus({ preventScroll: true });
    }
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
    if (!canSend) return;
    const previous = draft.attempt;
    const requestId = previous?.text === text && previous.attachments === attachments
      ? previous.requestId : draft.pendingRequestId ?? crypto.randomUUID();
    const attempt: SendAttempt = { text, attachments, requestId };
    update({ attempt, sending: true, error: undefined });
    textarea.current?.focus({ preventScroll: true });
    try {
      const destination = awaitingSavedModel ? resolveModel(await onLoadSavedModels()) : model;
      if (awaitingSavedModel && !form.current) {
        updateDraft((current) => current.attempt?.requestId === requestId ? { ...current, sending: false } : current);
        return;
      }
      if (!destination?.configured) throw new Error(desiredModel
        ? 'The selected model is unavailable. Choose another model or check its connection.'
        : 'Connect a model provider to send your message.');
      if (attachments.length && !destination.supportsImages) throw new Error('Choose a model that accepts images.');
      const input: StartChat = {
        projectId: project.id, requestId, text, model: { provider: destination.provider, id: destination.id },
        thinking: resolveThinking(destination),
        images: attachments.length ? attachments.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
      };
      if (selection) {
        await window.pideck.invoke('chat:send', { ...input, ...selection, delivery: queueing ? 'follow-up' : 'send' });
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
    if (!selection || runControlPending.current) return;
    runControlPending.current = 'cancel';
    setStopping(true);
    setRunControlError(undefined);
    try {
      await window.pideck.invoke('chat:cancel', selection);
    } catch (error) {
      setRunControlError(readableError(error));
      setStopping(false);
    } finally {
      runControlPending.current = undefined;
      setStopping(false);
    }
  }

  async function continueRun() {
    if (!selection || !view?.canContinue || runControlPending.current || busy) return;
    runControlPending.current = 'continue';
    setContinuing(true);
    setRunControlError(undefined);
    const failureTaskId = view.runOutcome?.taskId;
    if (!continueRequest.current || continueRequest.current.failureTaskId !== failureTaskId) {
      continueRequest.current = { failureTaskId, requestId: crypto.randomUUID() };
    }
    try {
      const catalog = awaitingSavedModel ? await onLoadSavedModels() : models;
      const destination = resolveModel(catalog);
      if (!destination?.configured) throw new Error('Connect this model provider or choose an available model.');
      await window.pideck.invoke('chat:continue', { ...selection, requestId: continueRequest.current.requestId,
        model: { provider: destination.provider, id: destination.id }, thinking: resolveThinking(destination) });
      jumpToLatest();
    } catch (error) {
      setRunControlError(readableError(error));
      setContinuing(false);
    } finally {
      runControlPending.current = undefined;
    }
  }

  async function addFiles(files: File[]) {
    if (draft.reading || draft.sending || draft.imagesUnavailable || !files.length) return;
    const existingSize = attachments.reduce((sum, file) => sum + file.data.length, 0);
    const additionalSize = files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
    if (files.length + attachments.length > 4 || additionalSize + existingSize > 12_000_000) {
      update({ error: 'Attach up to four images with a combined size of 9 MB.' });
      return;
    }
    update({ reading: true, error: undefined });
    try {
      const newAttachments = await Promise.all(files.map(readAttachment));
      const combined = [...attachments, ...newAttachments];
      const attachmentsKey = await persistDraftImages(project.id, session?.id ?? newSessionDraft, combined);
      updateDraft((current) => ({ ...current, attachments: combined, attachmentsKey, imagesUnavailable: undefined, pendingRequestId: undefined, reading: false }));
    } catch (error) {
      update({ reading: false, error: readableError(error) });
    }
  }

  async function removeFile(attachment: Attachment) {
    if (draft.reading || draft.sending) return;
    update({ reading: true, error: undefined });
    try {
      const remaining = attachments.filter(item => item !== attachment);
      const attachmentsKey = remaining.length ? await persistDraftImages(project.id, session?.id ?? newSessionDraft, remaining) : undefined;
      updateDraft(current => ({ ...current, attachments: remaining, attachmentsKey, pendingRequestId: undefined, reading: false }));
    } catch (error) { update({ reading: false, error: readableError(error) }); }
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
  const progress = busy && view ? runPhase(view.messages) : undefined;
  const runOutcome = !busy && !agentCompacting ? view?.runOutcome : undefined;
  const runState = continuing ? 'continuing' : stopping || view?.status === 'cancelling' ? 'cancelling'
    : busy || agentCompacting ? 'running' : runOutcome?.kind ?? (view?.error || runControlError ? 'failed' : view?.canContinue ? 'ready' : undefined);
  const runStatus = runControlError ?? (continuing ? 'Continuing…'
    : stopping || view?.status === 'cancelling' ? 'Cancelling…'
    : agentCompacting ? 'Summarizing context…'
    : view?.activity?.kind === 'retrying' ? retryTime ? `Model retry scheduled for ${retryTime}` : 'Retrying the model…'
    : view?.activity?.kind === 'waiting' ? 'Waiting for the provider…'
    : progress?.label ?? (runOutcome?.kind === 'cancelled' ? 'Cancelled' : runOutcome?.message ?? view?.error
      ?? (view?.canContinue ? 'Ready to continue' : undefined)));
  const runDetail = progress?.label === runStatus ? progress?.detail : undefined;
  const composerImages = queueEdit ? (queueContent?.token === queueEdit.token ? queueContent.images : []) : attachments;
  const queuedCount = view?.queued?.length ?? 0;
  const cancelScope = queuedCount ? `Cancel also withdraws ${queuedCount} queued message${queuedCount === 1 ? '' : 's'}.` : undefined;
  const controlIsContinue = continuing || !busy && !agentCompacting && !stopping && Boolean(view?.canContinue);
  const showRunControl = busy || agentCompacting || stopping || continuing || view?.canContinue;
  const runControlEnabled = showRunControl && connected && !stopping && !continuing && view?.status !== 'cancelling' && !draft.sending && !queueSaving;
  const showRunClock = view?.runStartedAt !== undefined && Number.isFinite(view.runStartedAt)
    && (view.runEndedAt === undefined || Number.isFinite(view.runEndedAt));
  const composerStatus = draft.sending ? awaitingSavedModel ? 'Loading saved models…' : 'Sending…'
    : draft.reading ? 'Attaching images…'
    : attachments.length > 0 && model && !model.supportsImages ? 'Choose a model that accepts images.'
    : !busy && modelsReady && !setupRequired && !savedConnectionsPending && modelName && !model?.configured
      ? <><span>Selected model unavailable</span><button className="inline-action" type="button"
        onClick={() => onSettings(desiredProvider)}>Connect {desiredProvider ? providerLabel(desiredProvider) : 'provider'}</button></>
      : undefined;
  const queueing = (busy || Boolean(view?.queued?.some(item => item.editing))) && !agentCompacting;
  const submitLabel = queueing ? 'Queue next' : 'Send';
  const thinkingOptions = model?.configured && model.thinking.length > 1 ? { level: thinking, labels: thinkingLabels } : undefined;
  const displayedThinking = busy ? view?.thinking ?? (activeKey ? 'off' : undefined) : model?.configured ? thinking : undefined;
  const hasThinking = model?.thinking.some(level => level !== 'off') ?? (view?.thinking !== undefined && view.thinking !== 'off');
  const thinkingLabel = hasThinking && displayedThinking ? thinkingLabels[displayedThinking] : undefined;
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
                <Message message={message} project={project} selection={selection} onReview={onReview} onFork={connected && !forking ? fork : undefined}
                  toolDisclosure={toolDisclosure} onToolExpand={setToolExpanded}
                  onCancelTool={connected && !stopping && view?.status !== 'cancelling' ? cancelTool : undefined} />
              </div>
            ))}
            {renderGaps()}
          </div>
        ) : null}
      </div>
      {jumpVisible && <div className="chat-jump-anchor"><button className="chat-jump" type="button" aria-label="Latest"
        title="Jump to latest message" onClick={jumpToLatest}><Icon name="arrowDown" /></button></div>}
      <div className="composer-wrap">
        {selection && <QueuedMessages selection={selection} items={view?.queued} canSteer={Boolean(view?.canSteerQueued)}
          enabled={connected && !stopping && !continuing && view?.status !== 'cancelling'}
          editingId={queueEdit?.id} onEdit={editQueuedMessage}
          onFocusComposer={() => textarea.current?.focus({ preventScroll: true })} />}
        {(draft.error || modelsError) && <div className="notice composer-notice" role="alert">
          <Icon name="alert" /><span>{draft.error ?? modelsError}</span>
          {draft.imagesUnavailable ? <>
            <button className="inline-action" type="button" onClick={() => {
              const draftId = session?.id ?? newSessionDraft;
              void hydrateDraftImages({ [project.id]: { [draftId]: draft } }, window.pideck).then(restored => {
                const next = restored[project.id][draftId];
                updateDraft(current => current.attachmentsKey === draft.attachmentsKey
                  ? { ...current, attachments: next.attachments, imagesUnavailable: next.imagesUnavailable, error: next.imagesUnavailable ? next.error : undefined } : current);
              });
            }}>Retry images</button>
            <button className="inline-action" type="button" onClick={() => update({ attachments: [], attachmentsKey: undefined, imagesUnavailable: undefined, error: undefined })}>Discard images</button>
          </> : draft.error && queueEdit && queueReady !== queueEdit.token
            ? <button className="icon-button" type="button" aria-label="Retry queue edit" title="Retry opening queued message"
              disabled={!connected} onClick={() => { update({ error: undefined }); setQueueRetry(value => value + 1); }}><Icon name="retry" /></button>
            : modelsError && !draft.error
            ? <button className="inline-action" type="button" onClick={onRetryModels}>Retry models</button>
            : <button className="icon-button" type="button" aria-label="Dismiss chat notice"
              onClick={() => update({ error: undefined })}><Icon name="close" /></button>}
        </div>}
        {(runStatus || showRunClock) && <div className="composer-run" data-run-state={runState ?? 'completed'}>
          <div className="run-state" ref={runStateElement} role={runStatus ? runControlError || runState === 'failed' ? 'alert' : 'status' : undefined}>
            {(busy || agentCompacting || continuing || stopping) && !runControlError && <span className="run-state-dot" />}
            {runStatus && <span className="run-state-label">{runStatus}</span>}
            {runDetail && <code className="run-detail" title={runDetail}>{runDetail}</code>}
            {(busy || agentCompacting) && cancelScope && <span className="run-cancel-scope">{cancelScope}</span>}
          </div>
          {showRunClock && <RunClock startedAt={view!.runStartedAt!} endedAt={view?.runEndedAt} />}
          {(showRunControl || showRunClock) && <button
            className="composer-run-control" data-action={controlIsContinue ? 'continue' : 'cancel'} type="button"
            title={controlIsContinue ? 'Continue unfinished work' : cancelScope ? `Cancel run. ${cancelScope}` : 'Cancel run'}
            aria-label={controlIsContinue ? 'Continue run' : 'Cancel run'}
            disabled={!runControlEnabled} aria-busy={stopping || continuing || undefined}
            onKeyDown={event => {
              if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
            }} onClick={event => {
              if (event.detail > 1) return;
              void (controlIsContinue ? continueRun() : cancel());
            }}><Icon name={controlIsContinue ? 'play' : 'stop'} /></button>}
        </div>}
        <form className="composer" ref={form} onSubmit={(event) => { event.preventDefault(); void (queueEdit ? saveQueueEdit() : send()); }}>
          {composerImages.length > 0 && <div className="attachments" role="group"
            aria-label={queueEdit ? 'Queued message attachments' : 'Message attachments'}>
            {composerImages.map((image, index) => (
              <div className="attachment" key={`${queueEdit?.token ?? 'draft'}/${index}`}>
                <ImageBlock image={image} alt={`Attached image ${index + 1}`} thumbnail />
                {!queueEdit && <button className="icon-button attachment-remove" type="button" aria-label={`Remove attached image ${index + 1}`}
                  title="Remove image"
                  disabled={draft.sending || draft.reading}
                  onClick={() => { void removeFile(attachments[index]); }}><Icon name="close" width={13} height={13} /></button>}
              </div>
            ))}
          </div>}
          <textarea ref={textarea} id="prompt" value={queueEdit?.text ?? text} maxLength={200000} rows={2}
            aria-label={queueEdit ? 'Edit queued message' : 'Message Pideck'} readOnly={queueSaving || Boolean(queueEdit && queueReady !== queueEdit.token)}
            placeholder={queueEdit ? queueEdit.loading ? 'Opening queued message…' : 'Edit queued message…' : queueing ? 'Write a follow-up…' : 'Message Pideck…'}
            onChange={(event) => {
              const value = event.target.value;
              updateDraft(current => queueEdit && current.queueEdit?.id === queueEdit.id
                ? { ...current, queueEdit: { ...current.queueEdit, text: value }, error: undefined }
                : queueEdit ? current : { ...current, text: value, pendingRequestId: undefined, error: undefined });
            }}
            onKeyDown={(event) => {
              if (queueEdit && event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                cancelQueueEdit();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (queueEdit && images.length) {
                if (!event.clipboardData.getData('text/plain')) event.preventDefault();
                return;
              }
              if (images.length) {
                if (canAttach && !startingSession) {
                  event.preventDefault();
                  void addFiles(images);
                } else if (!event.clipboardData.getData('text/plain')) {
                  if (!startingSession) update({ error: 'Choose a model that accepts images to paste a screenshot.' });
                }
              }
            }} />
          <div className="composer-controls">
            <div className="composer-models">
              {queueEdit ? <span className="queue-edit-label" role="img" aria-label={queueEdit.hasImages ? 'Editing queued message with images' : 'Editing queued message'}
                title={`Editing queued message${queueEdit.hasImages ? ' · existing image attachments are kept' : ''}`}>
                <Icon name="edit" width={14} height={14} />{queueEdit.hasImages && <Icon name="picture" width={14} height={14} />}
              </span> : <>
              {canAttach && <>
                <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple ref={fileInput}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void addFiles(files);
                  }} />
                <button className="icon-button composer-attach" type="button" title="Attach images" aria-label="Attach images"
                  disabled={draft.sending || draft.reading || draft.imagesUnavailable || attachments.length >= 4}
                  onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
              </>}
              {busy || agentCompacting || continuing ? modelName && <span className="composer-current-model" title={modelDescription}>{modelLabel}</span> : setupRequired
                ? <button className="button provider-setup-trigger" type="button" onClick={() => onSettings(desiredProvider)}>
                    <Icon name="key" width={14} height={14} /> Connect a provider
                  </button>
                : models.length > 0 || savedConnectionsPending ? <ModelPicker models={models} selected={model} label={modelLabel}
                    description={modelDescription} thinking={thinkingOptions} onLoadSavedModels={savedConnectionsPending ? onLoadSavedModels : undefined}
                    onThinkingChange={(level) => update({ thinking: level })}
                    onChoose={(option) => {
                      const key = modelKey(option);
                      update({ model: key, thinking: model && modelKey(model) === key ? draft.thinking : undefined, error: undefined });
                      onModelChosen(key);
                    }} /> : !modelsError && <span className="composer-current-model">Loading models…</span>}
              </>}
            </div>
            <div className="composer-actions">
              {queueEdit ? <div className="queue-edit-actions" role="group" aria-label="Queue edit actions">
                <button className="icon-button" type="button" aria-label="Cancel queue edit" title="Cancel editing (Esc)"
                  disabled={queueSaving || queueReady !== queueEdit.token} onClick={() => void cancelQueueEdit()}><Icon name="close" /></button>
                <button className="button button--primary queue-save-button" type="submit" aria-label="Save queued message"
                  title="Save queued message (Enter)" disabled={!canSaveQueue} aria-busy={queueSaving || undefined}>
                  <Icon name={queueSaving ? 'spinner' : 'check'} />
                </button>
              </div> :
              <button className="button button--primary send-button" type="submit" title={`${submitLabel} (Enter)`} aria-label={submitLabel}
                disabled={!canSend}><Icon name={queueing ? 'queue' : 'arrowUp'} width={17} height={17} /></button>}
            </div>
          </div>
        </form>
        {composerStatus && <div className="composer-status" role="status">{composerStatus}</div>}
      </div>
    </main>
  );
}
