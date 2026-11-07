import { RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthLink, AuthMethod, AuthNotice, AuthPrompt, ModelProvider } from '../shared/api';
import { readableError } from './conversation';
import { Icon } from './Icons';

type Prompt = { id: string; data: AuthPrompt };

function methodLabel(provider: ModelProvider, name: string) {
  const prefix = `${provider.name} `;
  if (!name.startsWith(prefix)) return name;
  const label = name.slice(prefix.length).trim();
  return label.startsWith('(') && label.endsWith(')') ? label.slice(1, -1) : label;
}

export function SettingsDialog({ initialProvider, onClose, onModelsChanged }: {
  initialProvider?: string;
  onClose: () => void;
  onModelsChanged: () => void;
}) {
  const api = window.pideck;
  const dialog = useRef<HTMLDialogElement>(null);
  const providerSelect = useRef<HTMLSelectElement>(null);
  const opener = useRef<Element | null>(null);
  const flowId = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const providerRead = useRef(0);
  const loadedProviders = useRef(false);
  const cancelled = useRef<string | undefined>(undefined);
  const promptForm = useRef<HTMLFormElement>(null);
  const [providers, setProviders] = useState<ModelProvider[]>();
  const [selected, setSelected] = useState(initialProvider);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<string>();
  const [prompt, setPrompt] = useState<Prompt>();
  const [answer, setAnswer] = useState('');
  const [answering, setAnswering] = useState(false);
  const [notices, setNotices] = useState<AuthNotice[]>([]);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [working, setWorking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [changeConnection, setChangeConnection] = useState(false);

  const connected = providers?.filter(({ configured }) => configured) ?? [];
  const available = providers?.filter(({ configured }) => !configured) ?? [];
  const provider = selected ? providers?.find(({ id }) => id === selected)
    : connected.length === 1 ? connected[0] : providers?.length === 1 ? providers[0] : undefined;
  const busy = working || Boolean(flow);

  useLayoutEffect(() => {
    if (dialog.current && !dialog.current.open) {
      opener.current = document.activeElement;
      dialog.current.showModal();
    }
  }, []);

  useLayoutEffect(() => {
    if (providers?.length && document.activeElement === dialog.current?.querySelector('.dialog-heading button')) {
      providerSelect.current?.focus();
    }
  }, [providers]);

  useLayoutEffect(() => {
    if (prompt) promptForm.current?.querySelector<HTMLElement>('input, select')?.focus();
  }, [prompt?.id]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== 'auth:prompt' && event.type !== 'auth:prompt-closed' && event.type !== 'auth:notice') return;
      if (event.flowId !== flowId.current) return;
      if (event.type === 'auth:prompt') {
        setPrompt({ id: event.promptId, data: event.prompt });
        setAnswer(event.prompt.type === 'select' ? event.prompt.options[0]?.id ?? '' : '');
        setAnswering(false);
      } else if (event.type === 'auth:prompt-closed') {
        setPrompt((current) => current?.id === event.promptId ? undefined : current);
      } else {
        const notice = event.notice;
        setNotices((current) => [...current.filter((item) => item.type !== notice.type || notice.type === 'info'), notice].slice(-6));
      }
    });
    void readProviders();
    return () => {
      mounted.current = false;
      unsubscribe();
      const id = flowId.current;
      flowId.current = undefined;
      if (id) void api.invoke('model:auth-cancel', { flowId: id }).catch(() => undefined);
    };
  }, [api]);

  async function readProviders() {
    const read = ++providerRead.current;
    setLoading(true);
    try {
      const items = await api.invoke('model:providers');
      if (mounted.current && read === providerRead.current) {
        setProviders(items.toSorted((left, right) => left.name.localeCompare(right.name)));
        if (!loadedProviders.current) {
          loadedProviders.current = true;
          onModelsChanged();
        }
      }
    } catch (cause) {
      if (mounted.current && read === providerRead.current) setError(readableError(cause));
    } finally {
      if (mounted.current && read === providerRead.current) setLoading(false);
    }
  }

  async function login(method: AuthMethod) {
    if (!provider || flowId.current || busy) return;
    const id = crypto.randomUUID();
    const selectedProvider = provider;
    flowId.current = id;
    cancelled.current = undefined;
    setFlow(id);
    setError(undefined);
    setStatus(undefined);
    setNotices([]);
    setAnswer('');
    setPrompt(undefined);
    try {
      await api.invoke('model:login', { flowId: id, provider: selectedProvider.id, method });
      if (flowId.current !== id) return;
      onModelsChanged();
      await readProviders();
      if (flowId.current === id) {
        setChangeConnection(false);
        setStatus(`${selectedProvider.name} connected.`);
      }
    } catch (cause) {
      if (flowId.current === id && cancelled.current !== id) setError(readableError(cause));
    } finally {
      if (flowId.current === id) {
        flowId.current = undefined;
        setFlow(undefined);
        setPrompt(undefined);
        setAnswer('');
        setAnswering(false);
        setNotices([]);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!flow || !prompt || answering || !answer.trim()) return;
    const value = answer;
    setAnswering(true);
    setError(undefined);
    if (prompt.data.type !== 'select') setAnswer('');
    try {
      await api.invoke('model:auth-answer', { flowId: flow, promptId: prompt.id, value });
    } catch (cause) {
      if (flowId.current === flow) {
        setError(readableError(cause));
        setAnswering(false);
      }
    }
  }

  async function cancel() {
    const id = flowId.current;
    if (!id || cancelled.current === id) return;
    cancelled.current = id;
    try {
      await api.invoke('model:auth-cancel', { flowId: id });
      if (!mounted.current) return;
      if (flowId.current && flowId.current !== id) return;
      flowId.current = undefined;
      setFlow(undefined);
      setPrompt(undefined);
      setNotices([]);
      setAnswer('');
      setAnswering(false);
      setError(undefined);
      setStatus('Connection cancelled.');
    } catch (cause) {
      if (flowId.current === id) {
        cancelled.current = undefined;
        setError(readableError(cause));
      }
    }
  }

  async function refresh() {
    if (!provider || busy) return;
    setWorking(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await api.invoke('model:refresh', { provider: provider.id });
      onModelsChanged();
      if (mounted.current) setStatus('Model list refreshed.');
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setWorking(false);
    }
  }

  function change() {
    if (!provider || busy) return;
    setStatus(undefined);
    setError(undefined);
    if (provider.methods.length === 1) void login(provider.methods[0]!.type);
    else setChangeConnection(true);
  }

  async function removeConnection() {
    if (!provider || busy || !confirmRemove) return;
    setWorking(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await api.invoke('model:logout', { provider: provider.id });
      onModelsChanged();
      await readProviders();
      if (mounted.current) setStatus(`${provider.name} connection removed.`);
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) {
        setWorking(false);
        setConfirmRemove(false);
      }
    }
  }

  function renderLink(link: AuthLink) {
    return <button type="button" key={link.id} className="button" title={link.label} onClick={() => {
      if (flow) void api.invoke('model:auth-open', { flowId: flow, linkId: link.id }).catch((cause) => setError(readableError(cause)));
    }}>Open {link.domain} <span aria-hidden="true">↗</span></button>;
  }

  function close() {
    dialog.current?.close();
    if (!opener.current?.isConnected) document.getElementById('prompt')?.focus();
    onClose();
  }

  return <dialog className="settings-dialog provider-dialog" ref={dialog} aria-labelledby="settings-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="dialog-heading">
      <h2 id="settings-title">Model providers</h2>
      <button className="icon-button" type="button" aria-label="Close settings" onClick={close}><Icon name="close" /></button>
    </div>
    <div className="settings-fields">
      <label>Provider
        <select ref={providerSelect} value={provider?.id ?? ''} disabled={busy || !providers?.length} onChange={(event) => {
          setSelected(event.target.value);
          setError(undefined);
          setStatus(undefined);
          setConfirmRemove(false);
          setChangeConnection(false);
        }}>
          <option value="" disabled>{loading ? 'Loading providers…' : providers?.length ? 'Choose a provider…' : 'No providers available'}</option>
          {connected.length > 0 && <optgroup label="Connected">
            {connected.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </optgroup>}
          {available.length > 0 && <optgroup label="Available to connect">
            {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </optgroup>}
        </select>
      </label>
    </div>
    {!provider && !loading && providers?.length ? <p className="provider-message">Choose a provider to connect an account or manage an existing connection.</p> : null}
    {provider && !flow && <section className="provider-connection" aria-label="Provider connection">
      {provider.configured && !changeConnection && <>
        <div className="provider-connection-header">
          <span className="key-status"><span aria-hidden="true" />Connected</span>
          <div className="provider-manage">
            {provider.dynamic && <button type="button" className="icon-button" aria-label="Refresh models"
              title="Refresh models" disabled={busy} onClick={refresh}><RefreshCw size={16} aria-hidden="true" /></button>}
            {!confirmRemove && <>
              {provider.methods.length > 0 && <button type="button" className="button provider-quiet" disabled={busy}
                onClick={change}>
                {provider.credential ? 'Change' : 'Add'}
              </button>}
              {provider.credential && <button type="button" className="button provider-quiet provider-danger" disabled={busy}
                onClick={() => { setConfirmRemove(true); setStatus(undefined); setError(undefined); }}>Remove</button>}
            </>}
          </div>
        </div>
        {confirmRemove && <div className="provider-confirm">
          <p className="provider-message">Remove the saved connection to {provider.name}?</p>
          <div className="provider-manage">
            <button type="button" className="button provider-quiet" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button type="button" className="button provider-danger" disabled={busy} onClick={removeConnection}>Remove</button>
          </div>
        </div>}
      </>}
      {(!provider.configured || changeConnection) && <>
        {provider.methods.length > 0
          ? <div className="provider-methods">
              <div className="provider-manage">
                {changeConnection && <button type="button" className="button provider-quiet" onClick={() => setChangeConnection(false)}>Back</button>}
                {provider.methods.map((method) => <button key={method.type} type="button"
                  className="button"
                  disabled={busy || loading} onClick={() => void login(method.type)}>{methodLabel(provider, method.name)}</button>)}
              </div>
            </div>
          : <p className="provider-message">This provider reads credentials from the environment where Pideck starts.</p>}
      </>}
    </section>}
    {flow && <section className="provider-flow" aria-label="Provider sign-in">
      {!prompt && <p className="provider-message" role="status">Waiting for {provider?.name ?? 'the provider'}…</p>}
      {notices.map((notice, index) => {
        if (notice.type === 'progress') return <p className="provider-message" key={index} role="status">{notice.message}</p>;
        if (notice.type === 'info') return <div className="provider-message" key={index}>
          <p>{notice.message}</p>{notice.links?.map(renderLink)}
        </div>;
        if (notice.type === 'auth_url') return <div className="provider-message" key={index}>
          {notice.instructions && <p>{notice.instructions}</p>}{renderLink(notice.link)}
        </div>;
        return <div className="provider-message" key={index}>
          <p>Enter this verification code to continue.</p>
          <div className="provider-code"><code>{notice.code}</code>{notice.copyId && <button type="button" className="button" onClick={() => {
            if (notice.copyId) void api.invoke('model:auth-copy', { flowId: flow, copyId: notice.copyId })
              .then(() => setStatus('Verification code copied.'), (cause) => setError(readableError(cause)));
          }}>Copy code</button>}</div>
          {notice.link && renderLink(notice.link)}
          {notice.expiresInSeconds !== undefined && <small>Expires after {Math.ceil(notice.expiresInSeconds / 60)} min</small>}
        </div>;
      })}
      {prompt && <form className="settings-fields provider-prompt" ref={promptForm} onSubmit={submit} key={prompt.id}>
        <label>{prompt.data.message}
          {prompt.data.type === 'select'
            ? <select value={answer} aria-label="Choose an option" disabled={answering} onChange={(event) => setAnswer(event.target.value)}>
                {prompt.data.options.map((item) => <option key={item.id} value={item.id}>{item.label}{item.description ? ` · ${item.description}` : ''}</option>)}
              </select>
            : <input type={prompt.data.type === 'text' ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={16_384}
                placeholder={prompt.data.placeholder} value={answer} disabled={answering} onChange={(event) => setAnswer(event.target.value)} />}
        </label>
        <button type="submit" className="button button--primary" disabled={answering || !answer.trim()}>{answering ? 'Continuing…' : 'Continue'}</button>
      </form>}
    </section>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {status && <p className="provider-message" role="status">{status}</p>}
    {!loading && !providers && <button type="button" className="button" onClick={() => { setError(undefined); void readProviders(); }}>Retry loading providers</button>}
    {flow && <div className="dialog-actions provider-manage">
      <button type="button" className="button provider-quiet" onClick={cancel}>Cancel sign-in</button>
    </div>}
  </dialog>;
}
