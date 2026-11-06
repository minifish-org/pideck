import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatBlock, ChatMessage, ImageInput, ModelOption, ModelRef, Project, Session, Thinking } from '../shared/api';
import { Icon } from './Icons';
import { readableError, useConversation } from './conversation';

const InlineDiff = lazy(() => import('./ReviewPanel').then(({ InlineDiff }) => ({ default: InlineDiff })));

export function modelKey(model: ModelRef) {
  return `${model.provider}/${model.id}`;
}

export function providerLabel(provider: string) {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter',
    github: 'GitHub', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral' } as Record<string, string>)[provider]
    ?? provider.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

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

function ToolCard({ block, onReview }: {
  block: Extract<ChatBlock, { type: 'tool' }>;
  onReview: (selection: ReviewSelection) => void;
}) {
  const command = block.arguments?.command;
  const argPath = block.arguments?.path;
  const path = block.path ?? (typeof argPath === 'string' ? argPath : undefined);
  const target = typeof command === 'string' ? command : path;
  const showReview = (block.name === 'edit' || block.name === 'write') && path && block.status === 'done';
  const status = { pending: 'Queued', running: 'Running', done: 'Done', error: 'Failed' }[block.status];
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
        <span className={`tool-state ${block.status === 'error' ? 'tool-state--error' : ''}`}>{status}</span>
        <Icon className="tool-caret" name="chevron" width={12} height={12} />
      </summary>
      <div className="tool-detail">
        {typeof command === 'string' && <div className="tool-command">$ {command}</div>}
        {block.patch
          ? <Suspense fallback={<div className="panel-loading" role="status">Loading diff…</div>}>
              <InlineDiff patch={block.patch} onOpen={() => onReview({ path, patch: block.patch })} />
            </Suspense>
          : <>
              {block.output && <pre className="tool-output">{block.output}</pre>}
              {showReview && <button className="button tool-review" type="button"
                onClick={() => onReview({ path, patch: block.patch })}><Icon name="diff" /> Open in review</button>}
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

function Message({ message, onReview }: {
  message: ChatMessage;
  onReview: (selection: ReviewSelection) => void;
}) {
  if (message.role === 'assistant' && !message.blocks.length && !message.error) return null;
  return (
    <article className={`chat-entry chat-entry--${message.role}`} aria-label={message.role === 'user' ? 'You' : 'Pideck'}>
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
    </article>
  );
}

export function EmptyScene({ icon, eyebrow, title, children }: {
  icon: 'mark' | 'folderPlus' | 'lock' | 'chat';
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-scene">
      <section className="empty-card">
        <div className="hero-mark"><Icon name={icon} /></div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </section>
    </div>
  );
}

type Attachment = ImageInput & { name: string };

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

export function Chat({ project, session, models, onSettings, onReview, onError, onSent }: {
  project: Project;
  session: Session;
  models: ModelOption[];
  onSettings: (provider: string) => void;
  onReview: (selection: ReviewSelection) => void;
  onError: (message: string) => void;
  onSent: () => void;
}) {
  const selection = { projectId: project.id, sessionId: session.id };
  const { view, connected, error: connectionError, retry } = useConversation(selection);
  const [pickedModel, setPickedModel] = useState('');
  const [pickedThinking, setPickedThinking] = useState<Thinking>();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);

  const hasMessages = Boolean(view?.messages.length);
  const busy = view?.status === 'running' || view?.status === 'cancelling';
  const desiredModel = pickedModel || (view?.model && modelKey(view.model));
  const model = models.find((option) => modelKey(option) === desiredModel)
    ?? models.find((option) => option.configured) ?? models[0];
  const desiredThinking = pickedThinking ?? view?.thinking ?? 'off';
  const thinking = model?.thinking.includes(desiredThinking) ? desiredThinking : model?.thinking[0] ?? 'off';
  const groupedModels = useMemo(() => Map.groupBy(models, ({ provider }) => provider), [models]);
  const canSend = connected && !busy && !pending && !reading && Boolean(model?.configured)
    && Boolean(text.trim() || attachments.length) && (!attachments.length || Boolean(model?.supportsImages));

  function jumpToLatest() {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    pinned.current = true;
    setJumpVisible(false);
  }

  useLayoutEffect(() => {
    if (scroll.current && pinned.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!canSend || !model) return;
    setPending(true);
    try {
      await window.pideck.invoke('chat:send', {
        ...selection,
        text: text.trim(),
        model: { provider: model.provider, id: model.id },
        thinking,
        images: attachments.length ? attachments.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
      });
      setText((current) => current === text ? '' : current);
      setAttachments((current) => current.filter((attachment) => !attachments.includes(attachment)));
      jumpToLatest();
      onSent();
    } catch (error) {
      onError(readableError(error));
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setStopping(true);
    try {
      await window.pideck.invoke('chat:cancel', selection);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setStopping(false);
    }
  }

  async function addFiles(files: File[]) {
    if (reading || !files.length) return;
    const existingSize = attachments.reduce((sum, file) => sum + file.data.length, 0);
    const additionalSize = files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
    if (files.length + attachments.length > 4 || additionalSize + existingSize > 12_000_000) {
      onError('Attach up to four images with a combined size of 9 MB.');
      return;
    }
    setReading(true);
    try {
      const newAttachments = await Promise.all(files.map(readAttachment));
      setAttachments((current) => [...current, ...newAttachments]);
    } catch (error) {
      onError(readableError(error));
    } finally {
      setReading(false);
    }
  }

  const sendHint = model && !model.configured
    ? <button className="inline-action" type="button" onClick={() => onSettings(model.provider)}>Set up {providerLabel(model.provider)} to send</button>
    : attachments.length > 0 && !model?.supportsImages
      ? 'Choose a model that accepts images'
      : 'Enter to send · Shift+Enter for a new line';

  return (
    <main className="chat" aria-label="Conversation">
      {!connected && (
        <div className={`notice ${connectionError ? '' : 'notice--info'}`} role={connectionError ? 'alert' : 'status'}>
          <Icon name={connectionError ? 'alert' : 'chat'} />
          <span>{connectionError ?? (view ? 'Reconnecting to the session…' : 'Opening the session…')}</span>
          {connectionError && <button className="button" type="button" onClick={retry}>Reconnect</button>}
        </div>
      )}
      <div className={`chat-scroll ${hasMessages || view?.error ? '' : 'chat-scroll--empty'}`} ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          setJumpVisible(!pinned.current);
        }}>
        {hasMessages || view?.error ? (
          <div className="chat-thread">
            {view?.messages.map((message) => <Message key={message.id} message={message} onReview={onReview} />)}
            {busy && <div className="run-state" role="status"><span className="run-state-dot" />{view?.status === 'cancelling' ? 'Stopping…' : 'Pideck is working'}</div>}
            {view?.error && <div className="notice" role="alert"><Icon name="alert" /><span>{view.error}</span></div>}
          </div>
        ) : (
          <EmptyScene icon="mark" eyebrow={project.name} title="What are we building?">
            <p>Ask Pideck to explore the codebase, make a change, or verify a fix.</p>
          </EmptyScene>
        )}
      </div>
      {jumpVisible && <div className="chat-jump-anchor"><button className="chat-jump" type="button" onClick={jumpToLatest}><Icon name="arrowDown" /> Latest</button></div>}
      <div className="composer-wrap">
        <form className="composer" ref={form} onSubmit={send}>
          {attachments.length > 0 && <div className="attachments">
            {attachments.map((attachment, index) => (
              <div className="attachment" key={index} title={attachment.name}>
                <img src={imageSource(attachment)} alt="" />
                <span>{attachment.name}</span>
                <button className="icon-button" type="button" aria-label={`Remove ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}><Icon name="close" width={13} height={13} /></button>
              </div>
            ))}
          </div>}
          <textarea id="prompt" value={text} maxLength={200000} rows={2} aria-label="Message Pideck"
            placeholder="Message Pideck…" onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (model?.supportsImages && images.length) {
                event.preventDefault();
                void addFiles(images);
              }
            }} />
          <div className="composer-controls">
            <div className="select-shell model-select">
              <select aria-label="Model" value={model ? modelKey(model) : ''} disabled={models.length === 0}
                onChange={(event) => { setPickedModel(event.target.value); setPickedThinking(undefined); }}>
                {!models.length && <option value="">Loading models…</option>}
                {[...groupedModels].map(([provider, options]) => (
                  <optgroup label={providerLabel(provider)} key={provider}>
                    {options.map((option) => <option value={modelKey(option)} key={modelKey(option)}>{option.name}{option.configured ? '' : ' · Setup required'}</option>)}
                  </optgroup>
                ))}
              </select>
              <Icon name="down" width={13} height={13} />
            </div>
            {model && model.thinking.length > 1 && <div className="select-shell">
              <select aria-label="Thinking level" value={thinking} onChange={(event) => setPickedThinking(event.target.value as Thinking)}>
                {model.thinking.map((level) => <option key={level} value={level}>{level === 'off' ? 'Thinking off' : `Thinking · ${level}`}</option>)}
              </select>
              <Icon name="down" width={13} height={13} />
            </div>}
            <div className="composer-spacer" />
            {model?.supportsImages && <>
              <input className="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple ref={fileInput}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  void addFiles(files);
                }} />
              <button className="icon-button" type="button" title="Attach images" aria-label="Attach images"
                disabled={reading || attachments.length >= 4} onClick={() => fileInput.current?.click()}><Icon name="image" /></button>
            </>}
            {busy
              ? <button className="button send-button stop-button" type="button" onClick={cancel} title="Stop the run" aria-label="Stop the run"
                  disabled={!connected || stopping || view?.status === 'cancelling'}><Icon name="stop" /></button>
              : <button className="button button--primary send-button" type="submit" title="Send" aria-label="Send" disabled={!canSend}><Icon name="arrowUp" /></button>}
          </div>
        </form>
        <div className="composer-hints"><span>{sendHint}</span><span>{session.title}</span></div>
      </div>
    </main>
  );
}
