import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthLink, AuthMethod, AuthNotice, AuthPrompt, ModelProvider } from '../shared/api';
import { readableError } from './conversation';
import { Icon } from './Icons';

type Prompt = { id: string; data: AuthPrompt };

export function SettingsDialog({ initialProvider, onClose, onModelsChanged }: {
  initialProvider?: string;
  onClose: () => void;
  onModelsChanged: () => void;
}) {
  const api = window.pideck;
  const dialog = useRef<HTMLDialogElement>(null);
  const flowId = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const providerRead = useRef(0);
  const cancelled = useRef<string | undefined>(undefined);
  const promptForm = useRef<HTMLFormElement>(null);
  const [providers, setProviders] = useState<ModelProvider[]>();
  const [selected, setSelected] = useState(initialProvider);
  const [preferredMethod, setPreferredMethod] = useState<AuthMethod>();
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<string>();
  const [prompt, setPrompt] = useState<Prompt>();
  const [answer, setAnswer] = useState('');
  const [answering, setAnswering] = useState(false);
  const [notices, setNotices] = useState<AuthNotice[]>([]);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [working, setWorking] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const provider = providers?.find(({ id }) => id === selected) ?? providers?.find(({ configured }) => configured) ?? providers?.[0];
  const method = provider?.methods.find(({ type }) => type === preferredMethod)
    ?? provider?.methods.find(({ type }) => type === provider.credential) ?? provider?.methods[0];
  const busy = working || Boolean(flow);

  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

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
      if (mounted.current && read === providerRead.current) setProviders(items.toSorted((left, right) => left.name.localeCompare(right.name)));
    } catch (cause) {
      if (mounted.current && read === providerRead.current) setError(readableError(cause));
    } finally {
      if (mounted.current && read === providerRead.current) setLoading(false);
    }
  }

  async function login() {
    if (!provider || !method || flowId.current || busy) return;
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
      await api.invoke('model:login', { flowId: id, provider: selectedProvider.id, method: method.type });
      if (flowId.current !== id) return;
      onModelsChanged();
      await readProviders();
      if (flowId.current === id) setStatus(`${selectedProvider.name} connected.`);
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

  async function disconnect() {
    if (!provider || busy || !confirmDisconnect) return;
    setWorking(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await api.invoke('model:logout', { provider: provider.id });
      onModelsChanged();
      await readProviders();
      if (mounted.current) setStatus(`${provider.name} disconnected.`);
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) {
        setWorking(false);
        setConfirmDisconnect(false);
      }
    }
  }

  function renderLink(link: AuthLink) {
    return <button type="button" key={link.id} className="button" title={link.label} onClick={() => {
      if (flow) void api.invoke('model:auth-open', { flowId: flow, linkId: link.id }).catch((cause) => setError(readableError(cause)));
    }}>Open {link.domain} <span aria-hidden="true">↗</span></button>;
  }

  return <dialog className="settings-dialog provider-dialog" ref={dialog} aria-labelledby="settings-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading">
      <h2 id="settings-title">Model providers</h2>
      <button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button>
    </div>
    <p className="dialog-copy">Connect a provider using its supported sign-in method.</p>
    <div className="settings-fields">
      <label>Provider
        <select value={provider?.id ?? ''} disabled={busy || !providers?.length} onChange={(event) => {
          setSelected(event.target.value); setPreferredMethod(undefined); setError(undefined); setStatus(undefined); setConfirmDisconnect(false);
        }}>
          {!providers?.length && <option value="">{loading ? 'Loading providers…' : 'No providers available'}</option>}
          {providers?.map((item) => <option key={item.id} value={item.id}>{item.name}{item.configured ? ' · Connected' : ''}</option>)}
        </select>
      </label>
      {provider && provider.methods.length > 1 && <label>Sign-in method
        <select value={method?.type ?? ''} disabled={busy} onChange={(event) => setPreferredMethod(event.target.value as AuthMethod)}>
          {provider.methods.map((item) => <option key={item.type} value={item.type}>{item.name}</option>)}
        </select>
      </label>}
    </div>
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
    <div className="dialog-actions provider-actions">
      {flow ? <button type="button" className="button" onClick={cancel}>Cancel sign-in</button> : <>
        <span className="key-status">{provider?.configured ? 'Connected' : provider ? 'Disconnected' : ''}</span>
        {provider?.configured && <button type="button" className="button" disabled={busy}
          onClick={refresh}>Refresh models</button>}
        {provider?.credential && <button type="button" className="button" disabled={busy}
          onClick={() => confirmDisconnect ? void disconnect() : setConfirmDisconnect(true)}>
          {confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'}
        </button>}
        {method && <button type="button" className="button button--primary" disabled={busy || loading} onClick={login}>
          <Icon name="key" /> {provider?.credential ? 'Reconnect' : method.name}
        </button>}
      </>}
    </div>
  </dialog>;
}
