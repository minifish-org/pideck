import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelOption, Project, Session } from '../shared/api';
import { Chat, EmptyScene } from './Chat';
import { readableError } from './conversation';
import { Icon } from './Icons';
import { SettingsDialog } from './Settings';
import { emptyDraft, readPreferences, savePreferences } from './preferences';
import type { Draft } from './preferences';

const ReviewPanel = lazy(() => import('./ReviewPanel').then(({ ReviewPanel }) => ({ default: ReviewPanel })));
const TerminalPanel = lazy(() => import('./TerminalPanel').then(({ TerminalPanel }) => ({ default: TerminalPanel })));

function Desktop() {
  const api = window.pideck;
  const isMac = api.platform === 'darwin';
  const modifier = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const [projects, setProjects] = useState<Project[]>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [preferences, setPreferences] = useState(readPreferences);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sessionList, setSessionList] = useState<{ projectId: string; items: Session[] }>();
  const [focusedSession, setFocusedSession] = useState<string>();
  const [projectsError, setProjectsError] = useState<string>();
  const [sessionsError, setSessionsError] = useState<{ projectId: string; message: string }>();
  const [modelsError, setModelsError] = useState<string>();
  const [modelsReady, setModelsReady] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [review, setReview] = useState<{ projectId: string; path?: string; patch?: string; selection?: number }>();
  const [terminal, setTerminal] = useState<{ projectId: string; visible: boolean }>();
  const [settings, setSettings] = useState<{ provider?: string }>();
  const [error, setError] = useState<string>();
  const [workspaceEpoch, refreshWorkspace] = useState(0);
  const [sessionsEpoch, refreshSessions] = useState(0);
  const [modelsEpoch, refreshModels] = useState(0);
  const [opening, setOpening] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [creating, setCreating] = useState(false);

  const { navigation } = preferences;
  const project = projects?.find(({ id }) => id === preferences.projectId) ?? projects?.[0];
  const projectId = project?.id;
  const sessions = sessionList && sessionList.projectId === projectId ? sessionList.items : undefined;
  const session = projectId ? sessions?.find(({ id }) => id === preferences.sessions[projectId]) ?? sessions?.[0] : undefined;
  const sessionsIssue = sessionsError?.projectId === projectId ? sessionsError?.message : undefined;
  const activeReview = review?.projectId === projectId ? review : undefined;
  const activeTerminal = terminal?.projectId === projectId ? terminal : undefined;
  const selectionRef = useRef({ projectId, sessionId: session?.id });
  useLayoutEffect(() => { selectionRef.current = { projectId, sessionId: session?.id }; }, [projectId, session?.id]);

  useEffect(() => {
    let active = true;
    setProjectsError(undefined);
    void api.invoke('project:list').then((result) => {
      if (active) setProjects(result);
    }).catch((cause) => { if (active) setProjectsError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch]);

  useEffect(() => {
    let active = true;
    setModelsError(undefined);
    void api.invoke('model:list').then((result) => {
      if (active) { setModels(result); setModelsReady(true); }
    }).catch((cause) => { if (active) setModelsError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch, modelsEpoch]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setSessionsError(undefined);
    void api.invoke('session:list', { projectId }).then((items) => {
      if (active) setSessionList({ projectId, items });
    }).catch((cause) => { if (active) setSessionsError({ projectId, message: readableError(cause) }); });
    return () => { active = false; };
  }, [api, projectId, workspaceEpoch, sessionsEpoch]);

  useEffect(() => api.onEvent((event) => {
    if (event.type === 'host:restart') refreshWorkspace((current) => current + 1);
  }), [api]);

  useEffect(() => savePreferences(preferences), [preferences]);

  useLayoutEffect(() => {
    if (!projectId) return;
    setPreferences((current) => {
      if (current.projectId === projectId && (!session || current.sessions[projectId] === session.id)) return current;
      return {
        ...current, projectId,
        sessions: session ? { ...current.sessions, [projectId]: session.id } : current.sessions,
      };
    });
  }, [projectId, session]);

  useLayoutEffect(() => {
    if (focusedSession && focusedSession === session?.id) {
      document.getElementById('prompt')?.focus();
      setFocusedSession(undefined);
    }
  }, [focusedSession, session?.id]);

  function toggleNavigation() {
    setPreferences((current) => ({ ...current, navigation: !current.navigation }));
  }

  function selectProject(id: string) {
    if (projectId === id) return;
    setPreferences((current) => ({ ...current, projectId: id }));
    setTerminal(undefined);
    setReview(undefined);
    setError(undefined);
  }

  const selectSession = useCallback((projectId: string, id: string) => {
    setPreferences((current) => ({ ...current, sessions: { ...current.sessions, [projectId]: id } }));
    setError(undefined);
  }, []);

  const openReview = useCallback(({ path, patch }: { path?: string; patch?: string }) => {
    if (projectId) setReview((current) => ({ projectId, path, patch, selection: (current?.selection ?? 0) + 1 }));
  }, [projectId]);
  const refreshReview = useCallback(() => setReviewVersion((current) => current + 1), []);

  const sessionId = session?.id;
  const updateActiveDraft = useCallback((update: (draft: Draft) => Draft) => {
    if (!sessionId) return;
    setDrafts((previous) => {
      const current = previous[sessionId] ?? emptyDraft;
      const next = update(current);
      return next === current ? previous : { ...previous, [sessionId]: next };
    });
  }, [sessionId]);

  function saveProject(project: Project) {
    setProjectsError(undefined);
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
      setFocusedSession(created.id);
      refreshSessions((current) => current + 1);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setCreating(false);
    }
  }

  const forkSession = useCallback(async (entryId: number) => {
    if (!projectId || !session) return;
    const forked = await api.invoke('chat:fork', { projectId, sessionId: session.id, entryId, title: `${session.title.slice(0, 100)} (fork)` });
    setSessionList((previous) => previous?.projectId === projectId
      ? { projectId, items: [forked, ...previous.items] } : previous);
    if (selectionRef.current.projectId === projectId && selectionRef.current.sessionId === session.id) {
      selectSession(projectId, forked.id);
      setFocusedSession(forked.id);
    }
    refreshSessions((current) => current + 1);
  }, [api, projectId, selectSession, session]);

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
      if (document.querySelector('dialog[open]')) return;
      const inTerminal = event.target instanceof Element && Boolean(event.target.closest('.xterm'));
      if (!isMac && inTerminal && !event.shiftKey && event.code !== 'Backquote') return;
      if (event.shiftKey && key === 'b') toggleNavigation();
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
          title={`Navigation (${modifier}${shift}B)`} aria-pressed={navigation} onClick={toggleNavigation}><Icon name="sidebar" /></button>
        <div className="title-divider" />
        <div className="breadcrumb">
          {project && <><Icon name="folder" width={13} height={13} /><span className={session ? 'breadcrumb-parent' : 'breadcrumb-current'}>{project.name}</span></>}
          {project && session && <><Icon className="breadcrumb-parent" name="chevron" width={11} height={11} /><span className="breadcrumb-current">{session.title}</span></>}
          {!project && <span>Workspace</span>}
        </div>
        <div className="title-actions">
          {!navigation && project?.trusted && <button className="icon-button" type="button"
            aria-label="New session" title={`New session (${modifier}N)`} disabled={creating || !sessions} onClick={createSession}><Icon name="plus" /></button>}
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
                {projectsError && <p className="nav-empty" role="alert">Could not load projects. <button className="inline-action"
                  type="button" onClick={() => refreshWorkspace((current) => current + 1)}>Retry</button></p>}
                {!projects?.length && !projectsError && <p className="nav-empty">{projects ? 'No folders open' : 'Loading folders…'}</p>}
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
                    {Boolean(drafts[item.id]?.text || drafts[item.id]?.attachments.length) && <span className="nav-draft" title="Draft" aria-label="Draft" />}
                  </button>)}
                {sessionsIssue && <p className="nav-empty" role="alert">Could not load sessions. <button className="inline-action"
                  type="button" onClick={() => refreshSessions((current) => current + 1)}>Retry</button></p>}
                {!sessions?.length && !sessionsIssue && <p className="nav-empty">{sessions ? 'No sessions yet' : 'Loading sessions…'}</p>}
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
              ? <EmptyScene icon="folderPlus" eyebrow="Get started" title="Open a project folder">
                  <p>Bring your local codebase into Pideck to inspect files, work with an agent, and review changes.</p>
                  {openButton}
                  {projectsError && <p role="alert">{projectsError} <button className="inline-action" type="button"
                    onClick={() => refreshWorkspace((current) => current + 1)}>Retry loading projects</button></p>}
                  {!projectsError && <p className="empty-secondary">After choosing a folder, you’ll review trust and start a session.</p>}
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
                      modelsReady={modelsReady} modelsError={modelsError} defaultModel={preferences.model}
                      draft={drafts[session.id] ?? emptyDraft} updateDraft={updateActiveDraft}
                      onModelChosen={(model) => setPreferences((current) => ({ ...current, model }))}
                      onRetryModels={() => refreshModels((current) => current + 1)}
                      onSettings={(provider) => setSettings({ provider })}
                      onReview={openReview} onWorkspaceChange={refreshReview}
                      onSent={() => refreshSessions((current) => current + 1)} onFork={forkSession} />
                  : <EmptyScene icon="chat" eyebrow={project.name} title="Start a coding session">
                      {sessionsIssue
                        ? <><p role="alert">{sessionsIssue}</p><button className="button" type="button"
                          onClick={() => refreshSessions((current) => current + 1)}>Retry loading sessions</button></>
                        : <><p>{sessions ? 'Start a conversation to explore this project or ask Pideck to make a change.' : 'Opening your workspace…'}</p>
                          <button className="button button--primary" type="button" disabled={creating || !sessions} onClick={createSession}>
                            <Icon name="plus" /> New session <kbd>{modifier}N</kbd>
                          </button></>}
                    </EmptyScene>}
            {project?.trusted && activeReview && <Suspense fallback={<div className="panel-loading panel-loading--review" role="status">Opening review…</div>}>
              <ReviewPanel project={project} selectedPath={activeReview.path} selectedPatch={activeReview.patch}
                refreshVersion={reviewVersion} selectionVersion={activeReview.selection} onClose={() => setReview(undefined)} />
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
        <button className="status-models" type="button" onClick={() => setSettings({})}>
          <Icon name="key" width={12} height={12} />
          {models.some(({ configured }) => configured) ? 'Providers' : 'Set up a model'}
        </button>
      </footer>
      {settings && <SettingsDialog initialProvider={settings.provider} onClose={() => setSettings(undefined)}
        onModelsChanged={() => refreshModels((current) => current + 1)} />}
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
