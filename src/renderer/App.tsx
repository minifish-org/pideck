import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ModelOption, Project, Session } from '../shared/api';
import { Chat, EmptyScene, providerLabel } from './Chat';
import { readableError } from './conversation';
import { Icon } from './Icons';
const ReviewPanel = lazy(() => import('./ReviewPanel').then(({ ReviewPanel }) => ({ default: ReviewPanel })));
const TerminalPanel = lazy(() => import('./TerminalPanel').then(({ TerminalPanel }) => ({ default: TerminalPanel })));

function SettingsDialog({ models, initialProvider, onClose, onSave }: {
  models: ModelOption[];
  initialProvider?: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const providers = [...new Set(models.map(({ provider }) => provider))];
  const [preferred, setPreferred] = useState(initialProvider);
  const provider = preferred && providers.includes(preferred) ? preferred : providers[0] ?? '';
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const configured = models.some((model) => model.provider === provider && model.configured);

  useLayoutEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!provider || saving || !key.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await window.pideck.invoke('model:save-key', { provider, key: key.trim() });
      setKey('');
      onSave();
    } catch (cause) {
      setError(readableError(cause));
      setSaving(false);
    }
  }

  return (
    <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <div className="dialog-heading">
        <h2 id="settings-title">Model providers</h2>
        <button className="icon-button" type="button" aria-label="Close settings" disabled={saving} onClick={onClose}><Icon name="close" /></button>
      </div>
      <p className="dialog-copy">Add a provider API key to use its models in chat.</p>
      <form onSubmit={save}>
        <div className="settings-fields">
          <label>Provider
            <select value={provider} disabled={saving || !providers.length}
              onChange={(event) => { setPreferred(event.target.value); setKey(''); setError(undefined); }}>
              {!providers.length && <option value="">No providers available</option>}
              {providers.map((id) => <option key={id} value={id}>{providerLabel(id)}</option>)}
            </select>
          </label>
          <label>API key
            <input type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={key} disabled={saving || !provider}
              placeholder={configured ? 'Enter a replacement key' : 'Paste an API key'} onChange={(event) => setKey(event.target.value)} />
          </label>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <span className="key-status">{provider ? configured ? 'Configured' : 'Key required' : 'Waiting for model providers'}</span>
          <button className="button button--primary" type="submit" disabled={saving || !key.trim() || !provider}>
            <Icon name="key" /> {saving ? 'Saving…' : 'Save key'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Desktop() {
  const api = window.pideck;
  const isMac = api.platform === 'darwin';
  const modifier = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const [projects, setProjects] = useState<Project[]>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [projectChoice, setProjectChoice] = useState<string>();
  const [sessionChoices, setSessionChoices] = useState<Record<string, string>>({});
  const [sessionList, setSessionList] = useState<{ projectId: string; items: Session[] }>();
  const [navigation, setNavigation] = useState(true);
  const [review, setReview] = useState<{ projectId: string; path?: string; patch?: string }>();
  const [terminal, setTerminal] = useState<{ projectId: string; visible: boolean }>();
  const [settings, setSettings] = useState<{ provider?: string }>();
  const [error, setError] = useState<string>();
  const [workspaceEpoch, refreshWorkspace] = useState(0);
  const [sessionsEpoch, refreshSessions] = useState(0);
  const [modelsEpoch, refreshModels] = useState(0);
  const [opening, setOpening] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [creating, setCreating] = useState(false);

  const project = projects?.find(({ id }) => id === projectChoice) ?? projects?.[0];
  const projectId = project?.id;
  const sessions = sessionList && sessionList.projectId === projectId ? sessionList.items : undefined;
  const session = projectId ? sessions?.find(({ id }) => id === sessionChoices[projectId]) ?? sessions?.[0] : undefined;
  const activeReview = review?.projectId === projectId ? review : undefined;
  const activeTerminal = terminal?.projectId === projectId ? terminal : undefined;

  useEffect(() => {
    let active = true;
    void api.invoke('project:list').then((result) => {
      if (active) setProjects(result);
    }).catch((cause) => { if (active) setError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch]);

  useEffect(() => {
    let active = true;
    void api.invoke('model:list').then((result) => {
      if (active) setModels(result);
    }).catch((cause) => { if (active) setError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch, modelsEpoch]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void api.invoke('session:list', { projectId }).then((items) => {
      if (active) setSessionList({ projectId, items });
    }).catch((cause) => { if (active) setError(readableError(cause)); });
    return () => { active = false; };
  }, [api, projectId, workspaceEpoch, sessionsEpoch]);

  useEffect(() => api.onEvent((event) => {
    if (event.type === 'host:restart') refreshWorkspace((current) => current + 1);
  }), [api]);

  function selectProject(id: string) {
    if (projectId === id) return;
    setProjectChoice(id);
    setTerminal(undefined);
    setReview(undefined);
    setError(undefined);
  }

  function selectSession(projectId: string, id: string) {
    setSessionChoices((choices) => ({ ...choices, [projectId]: id }));
    setError(undefined);
  }

  function saveProject(project: Project) {
    setProjects((previous) => {
      const projects = previous ?? [];
      return projects.some(({ id }) => id === project.id)
        ? projects.map((current) => current.id === project.id ? project : current)
        : [project, ...projects];
    });
  }

  async function openProject() {
    if (opening) return;
    setOpening(true);
    try {
      const result = await api.invoke('project:open');
      if (result) {
        saveProject(result);
        selectProject(result.id);
      }
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setOpening(false);
    }
  }

  async function trustProject() {
    if (!project || trusting) return;
    setTrusting(true);
    try {
      const trusted = await api.invoke('project:trust', { projectId: project.id });
      if (trusted) {
        saveProject(trusted);
        setError(undefined);
      }
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setTrusting(false);
    }
  }

  async function createSession() {
    if (!project?.trusted || !sessions || creating) return;
    setCreating(true);
    try {
      const created = await api.invoke('session:create', {
        projectId: project.id,
        title: `Session ${sessions.length + 1}`,
      });
      setSessionList((previous) => previous?.projectId === project.id
        ? { projectId: project.id, items: [created, ...previous.items] } : previous);
      selectSession(project.id, created.id);
      refreshSessions((current) => current + 1);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setCreating(false);
    }
  }

  function toggleTerminal() {
    if (project?.trusted) setTerminal({ projectId: project.id, visible: !activeTerminal?.visible });
  }

  function toggleReview() {
    if (project?.trusted) setReview(activeReview ? undefined : { projectId: project.id });
  }

  function focusComposer() {
    document.getElementById('prompt')?.focus();
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.repeat || event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (settings) return;
      const inTerminal = event.target instanceof Element && Boolean(event.target.closest('.xterm'));
      if (!isMac && inTerminal && !event.shiftKey && event.code !== 'Backquote') return;
      if (event.shiftKey && key === 'b') setNavigation((visible) => !visible);
      else if (event.shiftKey && key === 'd') toggleReview();
      else if (event.shiftKey) return;
      else if (event.code === 'Backquote') toggleTerminal();
      else if (key === 'o') void openProject();
      else if (key === 'n') void createSession();
      else if (key === ',') setSettings({});
      else if (key === 'l') focusComposer();
      else return;
      event.preventDefault();
      event.stopPropagation();
    }

    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  });

  const openButton = <button className="button button--primary" type="button" disabled={opening} onClick={openProject}>
    <Icon name="folderPlus" /> Open folder <kbd>{modifier}O</kbd>
  </button>;

  return (
    <div className={`app ${isMac ? 'app--mac' : ''}`}>
      <header className="titlebar">
        <div className="wordmark"><Icon name="mark" /> Pideck</div>
        <button className="icon-button" type="button" aria-label="Toggle navigation"
          title={`Navigation (${modifier}${shift}B)`} aria-pressed={navigation} onClick={() => setNavigation(!navigation)}><Icon name="sidebar" /></button>
        <div className="title-divider" />
        <div className="breadcrumb">
          {project && <><Icon name="folder" width={13} height={13} /><span className={session ? 'breadcrumb-parent' : 'breadcrumb-current'}>{project.name}</span></>}
          {project && session && <><Icon className="breadcrumb-parent" name="chevron" width={11} height={11} /><span className="breadcrumb-current">{session.title}</span></>}
          {!project && <span>Workspace</span>}
        </div>
        <div className="title-actions">
          <button className="icon-button" type="button" aria-label="Toggle terminal"
            title={`Terminal (${modifier}\`)`} aria-pressed={Boolean(activeTerminal?.visible)}
            disabled={!project?.trusted} onClick={toggleTerminal}><Icon name="terminal" /></button>
          <button className="icon-button" type="button" aria-label="Toggle review"
            title={`Review changes (${modifier}${shift}D)`} aria-pressed={Boolean(activeReview)}
            disabled={!project?.trusted} onClick={toggleReview}><Icon name="diff" /></button>
          <button className="icon-button" type="button" aria-label="Model settings"
            title={`Model settings (${modifier},)`} onClick={() => setSettings({})}><Icon name="settings" /></button>
        </div>
      </header>
      <div className="app-body">
        {navigation && (
          <aside className="navigation" aria-label="Workspace navigation">
            <div className="nav-scroll">
              <section className="nav-group" aria-labelledby="projects-label">
                <div className="nav-heading">
                  <h2 id="projects-label">Projects</h2>
                  <button className="icon-button" type="button" title="Open a project folder" aria-label="Open a project folder"
                    disabled={opening} onClick={openProject}><Icon name="plus" /></button>
                </div>
                {projects?.map((item) => <button className="nav-row" key={item.id} type="button" title={item.directory}
                  aria-current={item.id === projectId ? 'true' : undefined} onClick={() => selectProject(item.id)}>
                    <Icon name={item.trusted ? 'folder' : 'lock'} /><span>{item.name}</span>
                  </button>)}
                {!projects?.length && <p className="nav-empty">{projects ? 'No folders open' : 'Loading folders…'}</p>}
              </section>
              {project && <section className="nav-group" aria-labelledby="sessions-label">
                <div className="nav-heading">
                  <h2 id="sessions-label">Sessions</h2>
                  <button className="icon-button" type="button" aria-label="New session"
                    title={`New session (${modifier}N)`} disabled={creating || !project.trusted || !sessions} onClick={createSession}><Icon name="plus" /></button>
                </div>
                {sessions?.map((item) => <button className="nav-row" key={item.id} type="button" title={item.title}
                  aria-current={item.id === session?.id ? 'true' : undefined} onClick={() => selectSession(project.id, item.id)}>
                    <Icon name="chat" /><span>{item.title}</span>
                  </button>)}
                {!sessions?.length && <p className="nav-empty">{sessions ? 'No sessions yet' : 'Loading sessions…'}</p>}
              </section>}
            </div>
            <div className="nav-footer">
              <button className="nav-row" type="button" onClick={openProject} disabled={opening}>
                <Icon name="folderPlus" /><span>Open folder</span>
              </button>
            </div>
          </aside>
        )}
        <section className="workspace" aria-label="Workspace">
          {error && <div className="notice" role="alert"><Icon name="alert" /><span>{error}</span>
            <button className="icon-button" type="button" aria-label="Dismiss message" onClick={() => setError(undefined)}><Icon name="close" /></button>
          </div>}
          <div className="workspace-middle">
            {!project
              ? <EmptyScene icon="folderPlus" eyebrow="Workspace" title="Open a project folder">
                  <p>Pideck works in your local codebase. Pick a folder to start a coding session.</p>
                  {openButton}
                </EmptyScene>
              : !project.trusted
                ? <EmptyScene icon="lock" eyebrow={project.name} title="Trust this project to begin">
                    <p>Trust lets Pideck run commands and edit files as your user.</p>
                    <p className="empty-path">{project.directory}</p>
                    <button className="button button--primary" type="button" onClick={trustProject} disabled={trusting}>
                      <Icon name="shield" /> Trust project
                    </button>
                  </EmptyScene>
                : session
                  ? <Chat key={session.id} project={project} session={session} models={models}
                      onSettings={(provider) => setSettings({ provider })} onError={setError}
                      onReview={({ path, patch }) => setReview({ projectId: project.id, path, patch })}
                      onSent={() => {
                        selectSession(project.id, session.id);
                        refreshSessions((current) => current + 1);
                      }} />
                  : <EmptyScene icon="chat" eyebrow={project.name} title="Start a coding session">
                      <p>Each session keeps its own conversation and picks up where you left off.</p>
                      <button className="button button--primary" type="button" disabled={creating || !sessions} onClick={createSession}>
                        <Icon name="plus" /> New session <kbd>{modifier}N</kbd>
                      </button>
                    </EmptyScene>}
            {project?.trusted && activeReview && <Suspense fallback={<div className="panel-loading panel-loading--review" role="status">Opening review…</div>}>
              <ReviewPanel project={project} selectedPath={activeReview.path} selectedPatch={activeReview.patch}
                onClose={() => setReview(undefined)} />
            </Suspense>}
          </div>
          {project?.trusted && activeTerminal && <Suspense fallback={activeTerminal.visible && <div className="panel-loading panel-loading--terminal" role="status">Opening terminal…</div>}>
            <TerminalPanel key={project.id} project={project} visible={activeTerminal.visible}
              onClose={() => setTerminal({ projectId: project.id, visible: false })} />
          </Suspense>}
        </section>
      </div>
      <footer className="statusbar">
        {project && <><Icon name={project.trusted ? 'shield' : 'lock'} width={12} height={12} />
          <span className="status-project" title={project.directory}>{project.directory}</span></>}
        <span className="statusbar-spacer" />
        <span>{models.some(({ configured }) => configured) ? 'Models ready' : 'Model setup required'}</span>
      </footer>
      {settings && <SettingsDialog models={models} initialProvider={settings.provider} onClose={() => setSettings(undefined)} onSave={() => {
        setSettings(undefined);
        refreshModels((current) => current + 1);
      }} />}
    </div>
  );
}

export function App() {
  if (!window.pideck) return (
    <div className="app">
      <EmptyScene icon="mark" eyebrow="Pideck" title="Open the desktop app">
        <p>Launch Pideck to connect to your projects and conversations.</p>
      </EmptyScene>
    </div>
  );
  return <Desktop />;
}
