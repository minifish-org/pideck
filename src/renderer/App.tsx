import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelOption, Project, Selection, Session } from '../shared/api';
import { Chat, EmptyScene } from './Chat';
import { readableError } from './conversation';
import { Icon } from './Icons';
import { SettingsDialog } from './Settings';
import { emptyDraft, readPreferences, savePreferences, without } from './preferences';
import type { Draft } from './preferences';

const ReviewPanel = lazy(() => import('./ReviewPanel').then(({ ReviewPanel }) => ({ default: ReviewPanel })));
const TerminalPanel = lazy(() => import('./TerminalPanel').then(({ TerminalPanel }) => ({ default: TerminalPanel })));

type Removal = { projectId: string; sessionId?: string };
type RemovalCheck = { target: Removal; trigger: HTMLButtonElement; error: string };

function RemoveRowButton({ label, disabled, onClick }: {
  label: string;
  disabled: boolean;
  onClick: (button: HTMLButtonElement) => void;
}) {
  return <button className="icon-button nav-remove" type="button" aria-label={label} title={label}
    aria-disabled={disabled || undefined} onClick={(event) => { if (!disabled) onClick(event.currentTarget); }}>
    <Icon name="trash" width={14} height={14} />
  </button>;
}

function Desktop() {
  const api = window.pideck;
  const isMac = api.platform === 'darwin';
  const modifier = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const [projects, setProjects] = useState<Project[]>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [preferences, setPreferences] = useState(readPreferences);
  const savedAtStartup = useRef(preferences);
  const [drafts, setDrafts] = useState<Record<string, Record<string, Draft>>>({});
  const [sessionList, setSessionList] = useState<{ projectId: string; items: Session[] }>();
  const [focusedSession, setFocusedSession] = useState<Selection>();
  const [removing, setRemoving] = useState<Removal>();
  const removalInProgress = useRef<Removal | undefined>(undefined);
  const removalChecks = useRef(new Set<RemovalCheck>());
  const removed = useRef({ projects: new Set<string>(), sessions: new Set<string>() });
  const [removalFocus, setRemovalFocus] = useState<'project' | 'session'>();
  const [projectsError, setProjectsError] = useState<string>();
  const [sessionsError, setSessionsError] = useState<{ projectId: string; message: string }>();
  const [modelsError, setModelsError] = useState<string>();
  const [modelsReady, setModelsReady] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [review, setReview] = useState<{ projectId: string; sessionId?: string; path?: string; patch?: string; selection?: number }>();
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
  const sessionId = session?.id;
  const projectDrafts = projectId ? drafts[projectId] : undefined;
  const removingProject = removing && removing.projectId === projectId && !removing.sessionId;
  const sessionsIssue = sessionsError?.projectId === projectId ? sessionsError?.message : undefined;
  const activeReview = review?.projectId === projectId ? review : undefined;
  const activeTerminal = terminal?.projectId === projectId ? terminal : undefined;
  const selectionRef = useRef({ projectId, sessionId: session?.id });
  useLayoutEffect(() => { selectionRef.current = { projectId, sessionId: session?.id }; }, [projectId, session?.id]);

  useEffect(() => {
    let active = true;
    setProjectsError(undefined);
    void api.invoke('project:list').then((result) => {
      if (!active) return;
      setProjects(() => result.filter(({ id }) => !removed.current.projects.has(id)));
      const saved = savedAtStartup.current;
      const available = new Set(result.map(({ id }) => id));
      setPreferences((current) => {
        const projectId = current.projectId === saved.projectId && current.projectId && !available.has(current.projectId)
          ? undefined : current.projectId;
        let sessions = current.sessions;
        for (const [id, sessionId] of Object.entries(saved.sessions)) {
          if (!available.has(id) && sessions[id] === sessionId) sessions = without(sessions, id);
        }
        return projectId === current.projectId && sessions === current.sessions ? current : { ...current, projectId, sessions };
      });
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
      if (!active || removed.current.projects.has(projectId)) return;
      setSessionList((current) => removed.current.projects.has(projectId) ? current
        : { projectId, items: items.filter(({ id }) => !removed.current.sessions.has(id)) });
      const saved = savedAtStartup.current.sessions[projectId];
      if (saved && !items.some(({ id }) => id === saved)) {
        setPreferences((current) => current.sessions[projectId] === saved
          ? { ...current, sessions: without(current.sessions, projectId) } : current);
      }
    }).catch((cause) => {
      if (active && !removed.current.projects.has(projectId)) setSessionsError({ projectId, message: readableError(cause) });
    });
    return () => { active = false; };
  }, [api, projectId, workspaceEpoch, sessionsEpoch]);

  useEffect(() => savePreferences(preferences), [preferences]);

  useLayoutEffect(() => {
    if (!projectId) return;
    setPreferences((current) => {
      if (removed.current.projects.has(projectId) || (session && removed.current.sessions.has(session.id))) return current;
      if (current.projectId === projectId && (!session || current.sessions[projectId] === session.id)) return current;
      return {
        ...current, projectId,
        sessions: session ? { ...current.sessions, [projectId]: session.id } : current.sessions,
      };
    });
  }, [projectId, session]);

  useLayoutEffect(() => {
    if (focusedSession && focusedSession.projectId === projectId && focusedSession.sessionId === sessionId) {
      document.getElementById('prompt')?.focus();
      setFocusedSession(undefined);
    }
  }, [focusedSession, projectId, sessionId]);

  useLayoutEffect(() => {
    if (!removalFocus) return;
    const targetId = removalFocus === 'session'
      ? sessionId ? `nav-session-${sessionId}` : 'nav-new-session'
      : projectId ? `nav-project-${projectId}` : 'nav-open-project';
    const target = document.getElementById(targetId);
    (target instanceof HTMLButtonElement && !target.disabled ? target : document.getElementById('toggle-navigation'))?.focus();
    setRemovalFocus(undefined);
  }, [removalFocus, projectId, sessionId]);

  function toggleNavigation() {
    setPreferences((current) => ({ ...current, navigation: !current.navigation }));
  }

  function selectProject(id: string) {
    if (projectId === id || removed.current.projects.has(id)) return;
    setPreferences((current) => ({ ...current, projectId: id }));
    setTerminal(undefined);
    setReview(undefined);
    setError(undefined);
  }

  const selectSession = useCallback((projectId: string, id: string) => {
    setPreferences((current) => removed.current.projects.has(projectId) || removed.current.sessions.has(id) ? current
      : { ...current, sessions: { ...current.sessions, [projectId]: id } });
    setError(undefined);
  }, []);

  const openReview = useCallback(({ path, patch }: { path?: string; patch?: string }) => {
    if (projectId && sessionId) setReview((current) => removed.current.projects.has(projectId) || removed.current.sessions.has(sessionId)
      ? current : { projectId, sessionId, path, patch, selection: (current?.selection ?? 0) + 1 });
  }, [projectId, sessionId]);
  const refreshReview = useCallback(() => setReviewVersion((current) => current + 1), []);

  const updateActiveDraft = useCallback((update: (draft: Draft) => Draft) => {
    if (!projectId || !sessionId) return;
    setDrafts((previous) => {
      if (removed.current.projects.has(projectId) || removed.current.sessions.has(sessionId)) return previous;
      const projectDrafts = previous[projectId] ?? {};
      const current = projectDrafts[sessionId] ?? emptyDraft;
      const next = update(current);
      return next === current ? previous : { ...previous, [projectId]: { ...projectDrafts, [sessionId]: next } };
    });
  }, [projectId, sessionId]);

  function saveProject(project: Project) {
    setProjectsError(undefined);
    setProjects((previous) => {
      if (removed.current.projects.has(project.id)) return previous;
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
    if (!project || trusting || removingProject) return;
    setTrusting(true);
    try {
      const trusted = await api.invoke('project:trust', { projectId: project.id });
      if (trusted && !removed.current.projects.has(trusted.id)) {
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
    if (!project?.trusted || !sessions || creating || removingProject) return;
    setCreating(true);
    const titles = new Set(sessions.map(({ title }) => title));
    let number = sessions.length + 1;
    while (titles.has(`Session ${number}`)) number += 1;
    try {
      const created = await api.invoke('session:create', {
        projectId: project.id,
        title: `Session ${number}`,
      });
      if (removed.current.projects.has(project.id)) return;
      setSessionList((previous) => previous?.projectId === project.id
        ? { projectId: project.id, items: [created, ...previous.items] } : previous);
      selectSession(project.id, created.id);
      setFocusedSession({ projectId: project.id, sessionId: created.id });
      refreshSessions((current) => current + 1);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setCreating(false);
    }
  }

  const forkSession = useCallback(async (entryId: number) => {
    if (!projectId || !session || (removalInProgress.current?.projectId === projectId
      && (!removalInProgress.current.sessionId || removalInProgress.current.sessionId === session.id))) return;
    const forked = await api.invoke('chat:fork', { projectId, sessionId: session.id, entryId, title: `${session.title.slice(0, 100)} (fork)` });
    if (removed.current.projects.has(projectId)) return;
    setSessionList((previous) => previous?.projectId === projectId && !removed.current.sessions.has(forked.id)
      ? { projectId, items: [forked, ...previous.items] } : previous);
    if (selectionRef.current.projectId === projectId && selectionRef.current.sessionId === session.id
      && !removed.current.sessions.has(session.id) && !removed.current.sessions.has(forked.id)) {
      selectSession(projectId, forked.id);
      setFocusedSession({ projectId, sessionId: forked.id });
    }
    refreshSessions((current) => current + 1);
  }, [api, projectId, selectSession, session]);

  const forgetRemoval = useCallback(({ projectId, sessionId }: Removal, sessionIds: string[], trigger: HTMLButtonElement) => {
    const removedIds = new Set(sessionIds);
    for (const check of removalChecks.current) {
      if (check.target.projectId === projectId && (!sessionId || (check.target.sessionId && removedIds.has(check.target.sessionId)))) {
        removalChecks.current.delete(check);
      }
    }
    for (const id of removedIds) removed.current.sessions.add(id);
    if (!sessionId) {
      removed.current.projects.add(projectId);
      setProjects((current) => current?.filter(({ id }) => id !== projectId));
      setSessionsError((current) => current?.projectId === projectId ? undefined : current);
      setTerminal((current) => current?.projectId === projectId ? undefined : current);
    }
    setSessionList((current) => {
      if (current?.projectId !== projectId) return current;
      return sessionId ? { projectId, items: current.items.filter(({ id }) => !removedIds.has(id)) } : undefined;
    });
    setDrafts((current) => {
      if (!sessionId) return without(current, projectId);
      if (!current[projectId]) return current;
      const remaining = Object.fromEntries(Object.entries(current[projectId]).filter(([id]) => !removedIds.has(id)));
      return Object.keys(remaining).length ? { ...current, [projectId]: remaining } : without(current, projectId);
    });
    setPreferences((current) => ({
      ...current,
      projectId: !sessionId && current.projectId === projectId ? undefined : current.projectId,
      sessions: !sessionId || removedIds.has(current.sessions[projectId]) ? without(current.sessions, projectId) : current.sessions,
    }));
    setReview((current) => current?.projectId === projectId
      && (!sessionId || (current.sessionId !== undefined && removedIds.has(current.sessionId))) ? undefined : current);
    setFocusedSession((current) => current?.projectId === projectId
      && (!sessionId || removedIds.has(current.sessionId)) ? undefined : current);
    if (document.activeElement === trigger || document.activeElement === document.body) {
      setRemovalFocus(sessionId ? 'session' : 'project');
    }
  }, []);

  const checkRemoval = useCallback(async (check: RemovalCheck) => {
    const { target, trigger } = check;
    try {
      const projects = await api.invoke('project:list');
      let missing: Removal | undefined;
      if (!projects.some(({ id }) => id === target.projectId)) {
        missing = { projectId: target.projectId };
      } else if (target.sessionId) {
        const sessions = await api.invoke('session:list', { projectId: target.projectId });
        if (!sessions.some(({ id }) => id === target.sessionId)) missing = target;
      }
      if (!removalChecks.current.delete(check) || !missing) return;
      forgetRemoval(missing, missing.sessionId ? [missing.sessionId] : [], trigger);
      setError((current) => current === check.error ? undefined : current);
    } catch {
      // A replacement host may not be ready yet. Retry once its restart event arrives.
    }
  }, [api, forgetRemoval]);

  useEffect(() => api.onEvent((event) => {
    if (event.type !== 'host:restart') return;
    refreshWorkspace((current) => current + 1);
    for (const check of removalChecks.current) void checkRemoval(check);
  }), [api, checkRemoval]);

  async function remove(target: Removal, trigger: HTMLButtonElement) {
    if (removalInProgress.current) return;
    removalInProgress.current = target;
    setRemoving(target);
    setError(undefined);
    const { projectId, sessionId } = target;
    try {
      const result = sessionId
        ? await api.invoke('session:remove', { projectId, sessionId })
        : await api.invoke('project:remove', { projectId });
      if (!result) return;
      forgetRemoval(target, result.sessionIds, trigger);
      setError(result.warning);
    } catch (cause) {
      const error = readableError(cause);
      setError(error);
      const check = { target, trigger, error };
      removalChecks.current.add(check);
      void checkRemoval(check);
    } finally {
      removalInProgress.current = undefined;
      setRemoving(undefined);
    }
  }

  function toggleTerminal() {
    if (project?.trusted && !removingProject) setTerminal({ projectId: project.id, visible: !activeTerminal?.visible });
  }

  function toggleReview() {
    if (project?.trusted && !removingProject) setReview(activeReview ? undefined : { projectId: project.id });
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
        <button className="icon-button" id="toggle-navigation" type="button" aria-label="Toggle navigation"
          title={`Navigation (${modifier}${shift}B)`} aria-pressed={navigation} onClick={toggleNavigation}><Icon name="sidebar" /></button>
        <div className="title-divider" />
        <div className="breadcrumb">
          {project && <><Icon name="folder" width={13} height={13} /><span className={session ? 'breadcrumb-parent' : 'breadcrumb-current'}>{project.name}</span></>}
          {project && session && <><Icon className="breadcrumb-parent" name="chevron" width={11} height={11} /><span className="breadcrumb-current">{session.title}</span></>}
          {!project && <span>Workspace</span>}
        </div>
        <div className="title-actions">
          {!navigation && project?.trusted && <button className="icon-button" type="button"
            aria-label="New session" title={`New session (${modifier}N)`} disabled={creating || !sessions || removingProject} onClick={createSession}><Icon name="plus" /></button>}
          <button className="icon-button" type="button" aria-label="Toggle terminal"
            title={`Terminal (${modifier}\`)`} aria-pressed={Boolean(activeTerminal?.visible)}
            disabled={!project?.trusted || removingProject} onClick={toggleTerminal}><Icon name="terminal" /></button>
          <button className="icon-button" type="button" aria-label="Toggle review"
            title={`Review changes (${modifier}${shift}D)`} aria-pressed={Boolean(activeReview)}
            disabled={!project?.trusted || removingProject} onClick={toggleReview}><Icon name="diff" /></button>
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
                  <button className="icon-button" id="nav-open-project" type="button" title="Open a project folder" aria-label="Open a project folder"
                    disabled={opening} onClick={openProject}><Icon name="plus" /></button>
                </div>
                {projects?.map((item) => <div className="nav-item" key={item.id}>
                  <button className="nav-row" id={`nav-project-${item.id}`} type="button" title={item.directory}
                    aria-current={item.id === projectId ? 'true' : undefined} onClick={() => selectProject(item.id)}>
                    <Icon name={item.trusted ? 'folder' : 'lock'} /><span>{item.name}</span>
                  </button>
                  <RemoveRowButton label={`Remove project ${item.name}`} disabled={Boolean(removing)}
                    onClick={(button) => void remove({ projectId: item.id }, button)} />
                </div>)}
                {projectsError && <p className="nav-empty" role="alert">Could not load projects. <button className="inline-action"
                  type="button" onClick={() => refreshWorkspace((current) => current + 1)}>Retry</button></p>}
                {!projects?.length && !projectsError && <p className="nav-empty">{projects ? 'No folders open' : 'Loading folders…'}</p>}
              </section>
              {project && <section className="nav-group" aria-labelledby="sessions-label">
                <div className="nav-heading">
                  <h2 id="sessions-label">Sessions</h2>
                  <button className="icon-button" id="nav-new-session" type="button" aria-label="New session"
                    title={`New session (${modifier}N)`} disabled={creating || !project.trusted || !sessions || removingProject} onClick={createSession}><Icon name="plus" /></button>
                </div>
                {sessions?.map((item) => {
                  const draft = projectDrafts?.[item.id];
                  const hasDraft = Boolean(draft?.text || draft?.attachments.length);
                  return <div className="nav-item" key={item.id}>
                    <button className="nav-row" id={`nav-session-${item.id}`} type="button" title={item.title}
                      aria-current={item.id === sessionId ? 'true' : undefined} aria-description={hasDraft ? 'Unsent draft' : undefined}
                      onClick={() => selectSession(project.id, item.id)}>
                      <Icon name="chat" /><span>{item.title}</span>
                      {hasDraft && <span className="nav-draft" title="Draft" aria-hidden="true" />}
                    </button>
                    <RemoveRowButton label={`Remove session ${item.title}`} disabled={Boolean(removing)}
                      onClick={(button) => void remove({ projectId: project.id, sessionId: item.id }, button)} />
                  </div>;
                })}
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
                    <button className="button button--primary" type="button" onClick={trustProject} disabled={trusting || removingProject}>
                      <Icon name="shield" /> Trust project
                    </button>
                  </EmptyScene>
                : session
                  ? <Chat key={session.id} project={project} session={session} models={models}
                      modelsReady={modelsReady} modelsError={modelsError} defaultModel={preferences.model}
                      draft={projectDrafts?.[session.id] ?? emptyDraft} updateDraft={updateActiveDraft}
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
                          <button className="button button--primary" type="button" disabled={creating || !sessions || removingProject} onClick={createSession}>
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
