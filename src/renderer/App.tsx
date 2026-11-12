import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { DesktopNavigation, MenuAction, ModelCatalog, Project, Selection, Session, SessionBranch } from '../shared/api';
import { Chat, EmptyScene } from './Chat';
import { readableError } from './conversation';
import { Icon } from './Icons';
import { SessionName } from './SessionName';
import { SessionSearch } from './SessionSearch';
import { NavigationMenu } from './NavigationMenu';
import type { NavigationMenuTarget } from './NavigationMenu';
import { sessionTree } from './session-tree';
import { SettingsDialog } from './Settings';
import { activityLabels, useSessionActivity } from './session-activity';
import { useModalOpen } from './modal-visibility';
import { WorkspaceDivider } from './WorkspaceDivider';
import { NavigationDivider } from './NavigationDivider';
import { WorkspacePanelButtons } from './WorkspacePanelButtons';
import { acceptStartedDraft, emptyDraft, newSessionDraft, readDrafts, hydrateDraftImages, readPreferences, retainKeys, saveDrafts, savePreferences, without } from './preferences';
import type { Draft, ReadingPosition } from './preferences';

const ReviewPanel = lazy(() => import('./ReviewPanel').then(({ ReviewPanel }) => ({ default: ReviewPanel })));
const TerminalPanel = lazy(() => import('./TerminalPanel').then(({ TerminalPanel }) => ({ default: TerminalPanel })));
const splitWorkspaceWidth = 780;
// Switch the project tree to a drawer before its 208px dock would displace chat.
const compactNavigationQuery = `(max-width: ${splitWorkspaceWidth + 208}px)`;
const activityIcons = { running: 'spinner', finished: 'check', attention: 'alert' } as const;

type Removal = { projectId: string; sessionId?: string };
type RemovalCheck = { target: Removal; trigger: HTMLButtonElement; error: string };
type RenameTarget = Selection & { source: 'titlebar' | 'sidebar' };
type Review = { projectId: string; visible: boolean; sessionId?: string; path?: string; patch?: string; line?: number; selection?: number };

function closePopovers() {
  document.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach((panel) => panel.hidePopover());
}

function navigateRows(event: ReactKeyboardEvent<HTMLElement>) {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('.nav-item > .nav-row')) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.nav-item > .nav-row')];
  const index = rows.indexOf(event.target);
  const positions: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 };
  const next = Object.hasOwn(positions, event.key) ? positions[event.key] : undefined;
  if (next === undefined) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
}

function Desktop({ initialDrafts }: { initialDrafts: ReturnType<typeof readDrafts> }) {
  const api = window.pideck;
  const isMac = api.platform === 'darwin';
  const modifier = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const [projects, setProjects] = useState<Project[]>();
  const [{ models, savedConnectionsPending }, setModelCatalog] = useState<ModelCatalog>({ models: [], savedConnectionsPending: false });
  const [preferences, setPreferences] = useState(readPreferences);
  const savedAtStartup = useRef(preferences);
  const [drafts, setDrafts] = useState(initialDrafts);
  const draftsAtStartup = useRef(drafts);
  // Persist migrated window-only editors before any passive lease request.
  const savedDrafts = useRef<typeof drafts>({});
  const [sessionLists, setSessionLists] = useState<Record<string, Session[]>>({});
  const sessionListGeneration = useRef(0);
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>({});
  const [focusedSession, setFocusedSession] = useState<Selection>();
  const [focusWorkspace, setFocusWorkspace] = useState<string>();
  const [removing, setRemoving] = useState<Removal>();
  const [removalBlock, setRemovalBlock] = useState<{ target: Selection; branches: SessionBranch[] }>();
  const [renaming, setRenaming] = useState<RenameTarget>();
  const removalInProgress = useRef<Removal | undefined>(undefined);
  const removalChecks = useRef(new Set<RemovalCheck>());
  const removed = useRef({ projects: new Set<string>(), sessions: new Set<string>() });
  const [removalFocus, setRemovalFocus] = useState<Removal>();
  const [projectsError, setProjectsError] = useState<string>();
  const [recoveringHost, setRecoveringHost] = useState(false);
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [modelsError, setModelsError] = useState<string>();
  const [modelsReady, setModelsReady] = useState(false);
  const modelRequest = useRef(0);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [review, setReview] = useState<Review>();
  const [terminals, setTerminals] = useState<Record<string, boolean>>({});
  const [focusTerminal, setFocusTerminal] = useState<string>();
  const [resultNavigation, setResultNavigation] = useState(0);
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia(compactNavigationQuery).matches);
  const [drawerRequested, setDrawerRequested] = useState(false);
  const [canSplitWorkspace, setCanSplitWorkspace] = useState(false);
  const app = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const navigationPanel = useRef<HTMLElement>(null);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const [settings, setSettings] = useState<{ provider?: string }>();
  const [searching, setSearching] = useState(false);
  const [navigationMenu, setNavigationMenu] = useState<NavigationMenuTarget>();
  const closeNavigationMenu = useCallback(() => setNavigationMenu(undefined), []);
  const [error, setError] = useState<string>();
  const [workspaceEpoch, refreshWorkspace] = useState(0);
  const [sessionsEpoch, refreshSessions] = useState(0);
  const [modelsEpoch, refreshModels] = useState(0);
  const [opening, setOpening] = useState(false);
  const { navigation } = preferences;
  const project = projects?.find(({ id }) => id === preferences.projectId) ?? projects?.[0];
  const projectId = project?.id;
  const drawerOpen = compactNavigation && drawerRequested && Boolean(project);
  const dockedNavigation = !compactNavigation && navigation && Boolean(project);
  const showNavigation = drawerOpen || dockedNavigation;
  const isExpanded = (id: string) => projectExpansion[id] ?? id === projectId;
  const sessionScope = projects?.filter(item => searching || item.id === projectId || item.id === removalBlock?.target.projectId
    || (showNavigation && isExpanded(item.id)))
    .map(({ id }) => id).join(',');
  const sessions = projectId ? sessionLists[projectId] : undefined;
  const selected = projectId ? preferences.sessions[projectId] : undefined;
  const session = selected === newSessionDraft ? undefined : sessions?.find(({ id }) => id === selected) ?? sessions?.[0];
  const sessionId = session?.id;
  const draftId = sessionId ?? newSessionDraft;
  const blockingBranches = removalBlock?.branches.map(branch => {
    const current = sessionLists[removalBlock.target.projectId]?.find(({ id }) => id === branch.id);
    return { id: branch.id, title: current?.title ?? branch.title, ready: Boolean(current) };
  }) ?? [];
  const projectDrafts = projectId ? drafts[projectId] : undefined;
  const pendingDraft = projectDrafts?.[newSessionDraft];
  const hasNewDraft = Boolean(pendingDraft?.text.trim() || pendingDraft?.attachments.length);
  const removingProject = removing && removing.projectId === projectId && !removing.sessionId;
  const sessionsIssue = projectId ? sessionErrors[projectId] : undefined;
  const activeReview = review?.projectId === projectId ? review : undefined;
  const canUseWorkspace = Boolean(project && !removingProject);
  const canCreateSession = canUseWorkspace && Boolean(sessions);
  const showProviders = savedConnectionsPending || models.some(({ configured }) => configured) || !session;
  const reviewOpen = Boolean(activeReview?.visible);
  const reviewOverlaysChat = !canSplitWorkspace && reviewOpen;
  const terminalVisible = Boolean(projectId && terminals[projectId] && !reviewOpen);
  const terminalOverlaysChat = !canSplitWorkspace && terminalVisible;
  const toolsOpen = reviewOpen || terminalVisible;
  const toolsDocked = canSplitWorkspace && toolsOpen;
  const toolsOverlay = !canSplitWorkspace && toolsOpen;
  const sessionActivity = useSessionActivity();
  const nativeModalOpen = useModalOpen();
  const selectionRef = useRef({ projectId, sessionId: session?.id });
  useLayoutEffect(() => { selectionRef.current = { projectId, sessionId: session?.id }; }, [projectId, session?.id]);

  useEffect(() => {
    if (!showNavigation) setRenaming(current => current?.source === 'sidebar' ? undefined : current);
  }, [showNavigation]);

  useEffect(() => {
    const viewport = window.matchMedia(compactNavigationQuery);
    function update() {
      if (viewport.matches && (navigationPanel.current?.contains(document.activeElement)
        || document.activeElement?.classList.contains('navigation-divider'))) {
        document.getElementById('toggle-navigation')?.focus();
      }
      setCompactNavigation(viewport.matches);
      setDrawerRequested(false);
    }
    viewport.addEventListener('change', update);
    return () => viewport.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const panel = workspace.current;
    if (!panel) return;
    const measure = () => setCanSplitWorkspace(panel.clientWidth >= splitWorkspaceWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (drawerOpen) {
      closePopovers();
      const current = navigationPanel.current?.querySelector<HTMLButtonElement>('.nav-children [aria-current="true"]');
      (current ?? document.getElementById(`nav-project-${selectionRef.current.projectId}`))?.focus();
    }
  }, [drawerOpen]);

  useLayoutEffect(() => {
    if (toolsOverlay) closePopovers();
    if (terminalOverlaysChat && (document.activeElement === document.body
      || document.activeElement?.closest('.workspace-conversation'))) {
      document.getElementById('toggle-terminal')?.focus();
    }
  }, [terminalOverlaysChat, toolsOverlay]);

  useEffect(() => {
    let active = true;
    setProjectsError(undefined);
    void api.invoke('project:list').then((result) => {
      if (!active) return;
      setProjects(() => result.filter(({ id }) => !removed.current.projects.has(id)));
      const saved = savedAtStartup.current;
      const available = new Set(result.map(({ id }) => id));
      setSessionLists((current) => retainKeys(current, (id) => available.has(id)));
      setProjectExpansion((current) => retainKeys(current, (id) => available.has(id)));
      setDrafts((current) => retainKeys(current, (id) => !Object.hasOwn(draftsAtStartup.current, id) || available.has(id)));
      setPreferences((current) => {
        const projectId = current.projectId === saved.projectId && current.projectId && !available.has(current.projectId)
          ? undefined : current.projectId;
        let sessions = current.sessions;
        for (const [id, sessionId] of Object.entries(saved.sessions)) {
          if (!available.has(id) && sessions[id] === sessionId) sessions = without(sessions, id);
        }
        const reading = retainKeys(current.reading, (id) => !Object.hasOwn(saved.reading, id) || available.has(id));
        const reviewPaths = retainKeys(current.reviewPaths, (id) => !Object.hasOwn(saved.reviewPaths, id) || available.has(id));
        return projectId === current.projectId && sessions === current.sessions
          && reading === current.reading && reviewPaths === current.reviewPaths
          ? current : { ...current, projectId, sessions, reading, reviewPaths };
      });
    }).catch((cause) => { if (active) setProjectsError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch]);

  useEffect(() => {
    let active = true;
    const request = ++modelRequest.current;
    setModelsError(undefined);
    void api.invoke('model:list').then((result) => {
      if (active && request === modelRequest.current) { setModelCatalog(result); setModelsReady(true); }
    }).catch((cause) => { if (active && request === modelRequest.current) setModelsError(readableError(cause)); });
    return () => { active = false; };
  }, [api, workspaceEpoch, modelsEpoch]);

  const loadSavedModels = useCallback(async () => {
    const request = ++modelRequest.current;
    const result = await api.invoke('model:list', { useSaved: true });
    if (request === modelRequest.current) {
      setModelCatalog(result);
      setModelsReady(true);
      setModelsError(undefined);
    }
    return result.models;
  }, [api]);

  useEffect(() => {
    if (!sessionScope) return;
    let active = true;
    const generation = sessionListGeneration.current;
    setSessionErrors({});
    for (const projectId of sessionScope.split(',')) void api.invoke('session:list', { projectId }).then((items) => {
      if (!active || generation !== sessionListGeneration.current || removed.current.projects.has(projectId)) return;
      setSessionLists((current) => removed.current.projects.has(projectId) ? current
        : { ...current, [projectId]: items.filter(({ id }) => !removed.current.sessions.has(id)) });
      const saved = savedAtStartup.current.sessions[projectId];
      const available = new Set(items.map(({ id }) => id));
      const startupDrafts = draftsAtStartup.current[projectId];
      const pendingDraft = savedDrafts.current[projectId]?.[newSessionDraft];
      const pending = pendingDraft?.attempt?.requestId ?? pendingDraft?.pendingRequestId;
      const acceptedStart = pending && available.has(pending) && !removed.current.sessions.has(pending) ? pending : undefined;
      if (startupDrafts || acceptedStart) setDrafts((current) => {
        const next = acceptedStart ? acceptStartedDraft(current, projectId, acceptedStart) : current;
        const project = next[projectId];
        if (!project || !startupDrafts) return next;
        const kept = retainKeys(project, (id) => id === newSessionDraft || !Object.hasOwn(startupDrafts, id) || available.has(id));
        if (kept === project) return next;
        return Object.keys(kept).length ? { ...next, [projectId]: kept } : without(next, projectId);
      });
      const savedReading = savedAtStartup.current.reading[projectId];
      setPreferences((current) => {
        const selected = current.sessions[projectId];
        const sessions = acceptedStart && (selected === newSessionDraft || !selected)
          ? { ...current.sessions, [projectId]: acceptedStart }
          : saved && saved !== newSessionDraft && !available.has(saved) && selected === saved
            ? without(current.sessions, projectId) : current.sessions;
        const positions = current.reading[projectId];
        const kept = savedReading && positions
          ? retainKeys(positions, (id) => !Object.hasOwn(savedReading, id) || available.has(id)) : positions;
        const reading = kept === positions ? current.reading
          : kept && Object.keys(kept).length ? { ...current.reading, [projectId]: kept } : without(current.reading, projectId);
        return sessions === current.sessions && reading === current.reading ? current : { ...current, sessions, reading };
      });
    }).catch((cause) => {
      if (active && generation === sessionListGeneration.current && !removed.current.projects.has(projectId)) {
        setSessionErrors((current) => ({ ...current, [projectId]: readableError(cause) }));
      }
    });
    return () => { active = false; };
  }, [api, sessionScope, workspaceEpoch, sessionsEpoch]);

  useLayoutEffect(() => savePreferences(preferences), [preferences]);
  useLayoutEffect(() => {
    saveDrafts(savedDrafts.current, drafts, (projectId, draftId, cause) => {
      setDrafts(current => {
        const draft = current[projectId]?.[draftId];
        if (!draft || draft.error) return current;
        return { ...current, [projectId]: { ...current[projectId], [draftId]: { ...draft, error: readableError(cause) } } };
      });
    });
    savedDrafts.current = drafts;
  }, [drafts]);

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
    if (!project || focusWorkspace !== project.id || toolsOverlay) return;
    const target = document.getElementById('prompt');
    if (!target) return;
    target.focus();
    setFocusWorkspace(undefined);
  }, [focusWorkspace, project, session, sessions, toolsOverlay]);

  useLayoutEffect(() => {
    if (canCreateSession && !sessionId && !drawerOpen && !toolsOverlay && !settings && document.activeElement === document.body) {
      document.getElementById('prompt')?.focus();
    }
  }, [canCreateSession, drawerOpen, projectId, sessionId, settings, toolsOverlay]);

  useLayoutEffect(() => {
    if (!removalFocus) return;
    const { projectId: from, sessionId: removedSession } = removalFocus;
    const remaining = from === projectId ? sessionId : sessionLists[from]?.[0]?.id;
    const target = (removedSession && remaining ? document.getElementById(`nav-session-${remaining}`) : null)
      ?? (projectId ? document.getElementById(`nav-project-${removedSession ? from : projectId}`) : null)
      ?? document.getElementById(projectId ? 'toggle-navigation' : 'workspace-open-project');
    target?.focus();
    setRemovalFocus(undefined);
  }, [removalFocus, projectId, sessionId, sessionLists]);

  function toggleNavigation() {
    if (drawerOpen) {
      closeDrawer(true);
      return;
    }
    if (compactNavigation) {
      setDrawerRequested(true);
      return;
    }
    if (showNavigation && document.activeElement?.closest('.navigation, .navigation-divider')) {
      document.getElementById('toggle-navigation')?.focus();
    }
    setPreferences((current) => ({ ...current, navigation: !current.navigation }));
  }

  function closeDrawer(restoreFocus = false) {
    if (!drawerOpen) return;
    if (restoreFocus) document.getElementById('toggle-navigation')?.focus();
    setDrawerRequested(false);
  }

  function selectProject(id: string) {
    if (removed.current.projects.has(id)) return;
    setProjectExpansion((current) => {
      if (projectId === id && current[id] !== false) return current;
      const previous = projectId && current[projectId] === undefined ? { [projectId]: true } : {};
      return { ...current, ...previous, [id]: true };
    });
    if (projectId === id) return;
    setRenaming(undefined);
    setRemovalBlock(undefined);
    setPreferences((current) => ({
      ...current, projectId: id,
      sessions: projectId && current.sessions[projectId] === newSessionDraft && !hasNewDraft && !pendingDraft?.sending
        ? without(current.sessions, projectId) : current.sessions,
    }));
    setFocusWorkspace(undefined);
    setFocusTerminal(undefined);
    setReview(undefined);
    setError(undefined);
  }

  const selectSession = useCallback((projectId: string, id: string) => {
    if (removed.current.projects.has(projectId) || removed.current.sessions.has(id)) return;
    setRenaming(current => current?.source === 'titlebar' && current.sessionId !== id ? undefined : current);
    setPreferences((current) => removed.current.projects.has(projectId) || removed.current.sessions.has(id) ? current
      : { ...current, sessions: { ...current.sessions, [projectId]: id } });
    setReview((current) => current?.projectId === projectId && current.sessionId && current.sessionId !== id
      ? { projectId, visible: current.visible } : current);
    setError(undefined);
  }, []);

  const hideTerminal = useCallback((id: string) => {
    setTerminals((current) => current[id] ? { ...current, [id]: false } : current);
    setFocusTerminal((current) => current === id ? undefined : current);
  }, []);

  function hideReview() {
    setReview((current) => current?.visible ? { ...current, visible: false } : current);
  }

  const openReview = useCallback(({ path, patch, line }: { path?: string; patch?: string; line?: number }) => {
    if (!projectId || !sessionId || removed.current.projects.has(projectId) || removed.current.sessions.has(sessionId)) return;
    reviewOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hideTerminal(projectId);
    setReview((current) => ({ projectId, visible: true, sessionId, path, patch, line, selection: (current?.selection ?? 0) + 1 }));
  }, [hideTerminal, projectId, sessionId]);
  const selectWorkingTreeFile = useCallback((path: string) => {
    setReview(current => current && (current.patch || current.line !== undefined)
      ? { projectId: current.projectId, visible: current.visible, path } : current);
  }, []);
  const refreshReview = useCallback(() => setReviewVersion((current) => current + 1), []);

  const rememberReadingPosition = useCallback((position: ReadingPosition | undefined) => {
    if (!projectId || !sessionId) return;
    setPreferences((current) => {
      if (removed.current.projects.has(projectId) || removed.current.sessions.has(sessionId)) return current;
      const positions = current.reading[projectId] ?? {};
      const previous = positions[sessionId];
      if (previous?.messageId === position?.messageId && previous?.offset === position?.offset) return current;
      const next = position ? { ...positions, [sessionId]: position } : without(positions, sessionId);
      return { ...current, reading: Object.keys(next).length
        ? { ...current.reading, [projectId]: next } : without(current.reading, projectId) };
    });
  }, [projectId, sessionId]);

  const rememberReviewPath = useCallback((path: string | undefined) => {
    if (!projectId) return;
    setPreferences((current) => {
      if (removed.current.projects.has(projectId) || current.reviewPaths[projectId] === path) return current;
      return { ...current, reviewPaths: path
        ? { ...current.reviewPaths, [projectId]: path } : without(current.reviewPaths, projectId) };
    });
  }, [projectId]);

  const updateActiveDraft = useCallback((update: (draft: Draft) => Draft) => {
    if (!projectId) return;
    setDrafts((previous) => {
      if (removed.current.projects.has(projectId) || removed.current.sessions.has(draftId)) return previous;
      const projectDrafts = previous[projectId] ?? {};
      const current = projectDrafts[draftId] ?? emptyDraft;
      const next = update(current);
      return next === current ? previous : { ...previous, [projectId]: { ...projectDrafts, [draftId]: next } };
    });
  }, [draftId, projectId]);

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

  useEffect(() => {
    let active = true;
    let received = 0;
    function navigate(target: DesktopNavigation | null) {
      if (!active || !target || target.id <= received || removed.current.projects.has(target.project.id)
        || (target.session && removed.current.sessions.has(target.session.id))) return;
      received = target.id;
      const { project, session } = target;
      setProjects(previous => [project, ...(previous ?? []).filter(item => item.id !== project.id)]);
      if (session) setSessionLists(previous => ({ ...previous, [project.id]:
        [session, ...(previous[project.id] ?? []).filter(item => item.id !== session.id)] }));
      setPreferences(current => ({ ...current, projectId: project.id,
        sessions: session ? { ...current.sessions, [project.id]: session.id } : current.sessions,
        reading: session && target.showResult ? { ...current.reading,
          [project.id]: without(current.reading[project.id] ?? {}, session.id) } : current.reading }));
      setProjectExpansion(current => ({ ...current, [project.id]: true }));
      setDrawerRequested(false);
      setRenaming(undefined);
      setRemovalBlock(undefined);
      setSettings(undefined);
      setReview(undefined);
      setTerminals(current => current[project.id] ? { ...current, [project.id]: false } : current);
      setFocusWorkspace(project.id);
      setError(undefined);
      if (target.showResult) setResultNavigation(target.id);
    }
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'desktop:navigate') navigate(event.navigation);
    });
    // Subscribe before declaring readiness so Finder/notification entry points
    // cannot fall between the initial view and event subscription.
    void api.invoke('desktop:ready').then(navigate).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [api]);

  async function openProject() {
    if (opening) return;
    setOpening(true);
    try {
      const result = await api.invoke('project:open');
      if (result) {
        saveProject(result);
        selectProject(result.id);
        closeDrawer();
        revealConversation(result.id);
        setFocusWorkspace(result.id);
      }
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setOpening(false);
    }
  }

  function openSessionDraft(id = projectId) {
    if (!id || removed.current.projects.has(id) || !projects?.some(project => project.id === id)
      || (removing?.projectId === id && !removing.sessionId)) return;
    selectProject(id);
    selectSession(id, newSessionDraft);
    closeDrawer();
    revealConversation(id);
    setFocusWorkspace(id);
  }

  const attachStartedSession = useCallback((started: Session) => {
    const { projectId, id } = started;
    if (removed.current.projects.has(projectId) || removed.current.sessions.has(id)) return;
    sessionListGeneration.current += 1;
    setSessionLists((current) => ({ ...current, [projectId]: [started, ...(current[projectId] ?? []).filter((item) => item.id !== id)] }));
    const draft = savedDrafts.current[projectId]?.[newSessionDraft];
    if ((draft?.attempt?.requestId ?? draft?.pendingRequestId) === id) {
      setDrafts((current) => acceptStartedDraft(current, projectId, id));
      const active = selectionRef.current.projectId === projectId && !selectionRef.current.sessionId;
      if (active) {
        selectSession(projectId, id);
        if (document.activeElement?.id === 'prompt') setFocusedSession({ projectId, sessionId: id });
      } else {
        setPreferences((current) => current.sessions[projectId] === newSessionDraft
          ? { ...current, sessions: { ...current.sessions, [projectId]: id } } : current);
      }
    }
    refreshSessions((current) => current + 1);
  }, [selectSession]);
  const forkSession = useCallback(async (entryId: number) => {
    if (!projectId || !session || (removalInProgress.current?.projectId === projectId
      && (!removalInProgress.current.sessionId || removalInProgress.current.sessionId === session.id))) return;
    const forked = await api.invoke('chat:fork', { projectId, sessionId: session.id, entryId });
    if (removed.current.projects.has(projectId)) return;
    sessionListGeneration.current += 1;
    setSessionLists((previous) => !removed.current.sessions.has(forked.id)
      ? { ...previous, [projectId]: [forked, ...(previous[projectId] ?? []).filter(item => item.id !== forked.id)] } : previous);
    if (selectionRef.current.projectId === projectId && selectionRef.current.sessionId === session.id
      && !removed.current.sessions.has(session.id) && !removed.current.sessions.has(forked.id)) {
      selectSession(projectId, forked.id);
      setFocusedSession({ projectId, sessionId: forked.id });
    }
    refreshSessions((current) => current + 1);
  }, [api, projectId, selectSession, session]);

  async function finishRename(title: string | undefined, restoreFocus: boolean) {
    if (!renaming) return;
    const { projectId, sessionId, source } = renaming;
    setRenaming(undefined);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          document.getElementById(source === 'titlebar' ? 'rename-current-session' : `nav-session-${sessionId}`)?.focus();
        }
      });
    }
    if (!title) return;
    try {
      const updated = await api.invoke('session:rename', { projectId, sessionId, title });
      if (removed.current.projects.has(projectId) || removed.current.sessions.has(sessionId)) return;
      sessionListGeneration.current += 1;
      setSessionLists(previous => previous[projectId]
        ? { ...previous, [projectId]: previous[projectId].map(item => item.id === sessionId ? { ...item, ...updated } : item) } : previous);
      refreshSessions(current => current + 1);
    } catch (cause) {
      if (selectionRef.current.projectId === projectId && !removed.current.sessions.has(sessionId)) {
        setError(readableError(cause));
      }
    }
  }

  const forgetRemoval = useCallback(({ projectId, sessionId }: Removal, sessionIds: string[], trigger: HTMLButtonElement) => {
    const removedIds = new Set(sessionIds);
    setRemovalBlock(current => {
      if (current?.target.projectId !== projectId) return current;
      if (!sessionId || current.target.sessionId === sessionId) return undefined;
      const branches = current.branches.filter(branch => !removedIds.has(branch.id));
      return branches.length ? { ...current, branches } : undefined;
    });
    for (const check of removalChecks.current) {
      if (check.target.projectId === projectId && (!sessionId || (check.target.sessionId && removedIds.has(check.target.sessionId)))) {
        removalChecks.current.delete(check);
      }
    }
    for (const id of removedIds) removed.current.sessions.add(id);
    if (!sessionId) {
      removed.current.projects.add(projectId);
      setProjects((current) => current?.filter(({ id }) => id !== projectId));
      setSessionErrors((current) => without(current, projectId));
      setProjectExpansion((current) => without(current, projectId));
      setTerminals((current) => without(current, projectId));
      setFocusTerminal((current) => current === projectId ? undefined : current);
    }
    setSessionLists((current) => {
      if (!current[projectId]) return current;
      return sessionId ? { ...current, [projectId]: current[projectId].filter(({ id }) => !removedIds.has(id)) } : without(current, projectId);
    });
    setDrafts((current) => {
      if (!sessionId) return without(current, projectId);
      if (!current[projectId]) return current;
      const remaining = Object.fromEntries(Object.entries(current[projectId]).filter(([id]) => !removedIds.has(id)));
      return Object.keys(remaining).length ? { ...current, [projectId]: remaining } : without(current, projectId);
    });
    setPreferences((current) => {
      const positions = current.reading[projectId];
      const remaining = sessionId && positions ? retainKeys(positions, (id) => !removedIds.has(id)) : undefined;
      return {
        ...current,
        projectId: !sessionId && current.projectId === projectId ? undefined : current.projectId,
        sessions: !sessionId || removedIds.has(current.sessions[projectId]) ? without(current.sessions, projectId) : current.sessions,
        reading: remaining && Object.keys(remaining).length
          ? { ...current.reading, [projectId]: remaining } : without(current.reading, projectId),
        reviewPaths: sessionId ? current.reviewPaths : without(current.reviewPaths, projectId),
      };
    });
    setReview((current) => current?.projectId === projectId
      && (!sessionId || (current.sessionId !== undefined && removedIds.has(current.sessionId))) ? undefined : current);
    setFocusedSession((current) => current?.projectId === projectId
      && (!sessionId || removedIds.has(current.sessionId)) ? undefined : current);
    if (document.activeElement === trigger || document.activeElement === document.body) {
      setRemovalFocus({ projectId, sessionId });
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
    if (event.type !== 'host:restart' && event.type !== 'host:resume') return;
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
      if ('blockingBranches' in result) {
        if (sessionId) {
          setRemovalBlock({ target: { projectId, sessionId }, branches: result.blockingBranches });
          if (result.blockingBranches.some(branch => !sessionLists[projectId]?.some(item => item.id === branch.id))) {
            refreshSessions(current => current + 1);
          }
          if (drawerOpen) {
            closeDrawer();
            requestAnimationFrame(() => document.getElementById('removal-branches')?.focus());
          }
        }
        return;
      }
      forgetRemoval(target, result.sessionIds, trigger);
      setError(result.warning);
    } catch (cause) {
      const error = readableError(cause);
      setError(error);
      if (drawerOpen) {
        closeDrawer();
        requestAnimationFrame(() => document.getElementById('workspace-notice')?.focus());
      }
      const check = { target, trigger, error };
      removalChecks.current.add(check);
      void checkRemoval(check);
    } finally {
      removalInProgress.current = undefined;
      setRemoving(undefined);
    }
  }

  const closeTerminal = useCallback((id: string) => {
    const focused = document.activeElement;
    const restoreFocus = selectionRef.current.projectId === id && focused?.closest('#workspace-terminal');
    hideTerminal(id);
    if (restoreFocus) requestAnimationFrame(() => {
      if (selectionRef.current.projectId === id && (document.activeElement === focused || document.activeElement === document.body)) {
        document.getElementById('toggle-terminal')?.focus();
      }
    });
  }, [hideTerminal]);

  function revealConversation(id: string) {
    if (canSplitWorkspace) return;
    hideReview();
    hideTerminal(id);
  }

  function toggleTerminal() {
    if (!project || removingProject) return;
    closeDrawer();
    if (terminalVisible) {
      closeTerminal(project.id);
      return;
    }
    hideReview();
    setFocusTerminal(project.id);
    setTerminals((current) => ({ ...current, [project.id]: true }));
  }

  function toggleReview() {
    if (!project || removingProject) return;
    closeDrawer();
    const trigger = document.getElementById('toggle-review');
    if (reviewOpen) {
      reviewOpener.current = trigger;
      closeReview();
      return;
    }
    if (document.activeElement?.closest('#workspace-terminal')) trigger?.focus();
    reviewOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    hideTerminal(project.id);
    setReview((current) => current?.projectId === project.id
      ? { ...current, visible: true } : { projectId: project.id, visible: true });
  }

  function closeReview() {
    hideReview();
    requestAnimationFrame(() => {
      const opener = reviewOpener.current;
      if (opener?.isConnected && opener !== document.body && !opener.closest('[hidden], [inert]')) opener.focus();
      else (document.getElementById('toggle-review') ?? document.getElementById('prompt'))?.focus();
    });
  }

  async function recoverHost() {
    if (recoveringHost) return;
    setRecoveringHost(true);
    try {
      await window.pideck.invoke('host:recover');
      refreshWorkspace(current => current + 1);
      refreshSessions(current => current + 1);
    } catch (cause) { setError(readableError(cause)); }
    finally { setRecoveringHost(false); }
  }

  function focusComposer() {
    if (projectId && (drawerOpen || toolsOverlay)) {
      closeDrawer();
      revealConversation(projectId);
      setFocusWorkspace(projectId);
    } else document.getElementById('prompt')?.focus();
  }

  function openSessionSearch() {
    if (!projects?.length) return;
    closePopovers();
    setNavigationMenu(undefined);
    setSearching(true);
  }

  function openSearchResult(result: Session) {
    selectProject(result.projectId);
    selectSession(result.projectId, result.id);
    setSearching(false);
    closeDrawer();
    revealConversation(result.projectId);
    setFocusedSession({ projectId: result.projectId, sessionId: result.id });
  }

  function showNavigationMenu(target: Removal, name: string, trigger: HTMLButtonElement, position?: { x: number; y: number }) {
    if (removing) return;
    closePopovers();
    trigger.focus({ preventScroll: true });
    const bounds = trigger.getBoundingClientRect();
    setNavigationMenu({ selection: target, name, trigger, x: position?.x ?? bounds.left + 20, y: position?.y ?? bounds.bottom });
  }

  function navigationContext(event: ReactMouseEvent<HTMLButtonElement>, target: Removal, name: string) {
    event.preventDefault();
    showNavigationMenu(target, name, event.currentTarget, { x: event.clientX, y: event.clientY });
  }

  function navigationAction(event: ReactKeyboardEvent<HTMLButtonElement>, target: Removal, name: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault();
      showNavigationMenu(target, name, event.currentTarget);
      return true;
    }
    if (!event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      if (!removing) void remove(target, event.currentTarget);
      return true;
    }
    return false;
  }

  function handleMenuAction(action: MenuAction) {
    if (document.querySelector('dialog[open]')) return;
    closePopovers();
    setNavigationMenu(undefined);
    switch (action) {
      case 'open-project': void openProject(); break;
      case 'search-sessions': openSessionSearch(); break;
      case 'new-session': openSessionDraft(); break;
      case 'settings': setSettings({}); break;
      case 'toggle-navigation': if (project) toggleNavigation(); break;
      case 'toggle-review': toggleReview(); break;
      case 'toggle-terminal': toggleTerminal(); break;
      case 'focus-composer': focusComposer(); break;
    }
  }

  const modalOpen = Boolean(settings || searching);
  useEffect(() => {
    const context = { projectId, sessionId, viewing: Boolean(sessionId && !toolsOverlay && !drawerOpen && !nativeModalOpen) };
    void api.invoke('desktop:context', context).catch(() => {});
    document.title = [session?.title, project?.name, 'Pideck'].filter(Boolean).join(' — ');
  }, [api, projectId, sessionId, project?.name, session?.title, toolsOverlay, drawerOpen, nativeModalOpen, workspaceEpoch]);

  useEffect(() => {
    const unsubscribe = api.onMenuAction?.(handleMenuAction);
    function handleShortcut(event: KeyboardEvent) {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.repeat || event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (document.querySelector('dialog[open]')) return;
      const inTerminal = event.target instanceof Element && Boolean(event.target.closest('.xterm'));
      if (!isMac && inTerminal && !event.shiftKey && event.code !== 'Backquote') return;
      let action: MenuAction;
      if (event.shiftKey && key === 'b') action = 'toggle-navigation';
      else if (event.shiftKey && key === 'd') action = 'toggle-review';
      else if (isMac ? event.shiftKey && key === 't' : !event.shiftKey && event.code === 'Backquote') action = 'toggle-terminal';
      else if (event.shiftKey) return;
      else if (key === 'o') action = 'open-project';
      else if (key === 'n') action = 'new-session';
      else if (key === 'k') action = 'search-sessions';
      else if (key === ',') action = 'settings';
      else if (key === 'l') action = 'focus-composer';
      else return;
      event.preventDefault();
      event.stopPropagation();
      handleMenuAction(action);
    }

    if (isMac && api.onMenuAction) return unsubscribe;
    window.addEventListener('keydown', handleShortcut, true);
    return () => {
      unsubscribe?.();
      window.removeEventListener('keydown', handleShortcut, true);
    };
  });

  useEffect(() => {
    api.updateMenu?.({
      canOpenProject: !opening && !modalOpen,
      canSearchSessions: Boolean(projects?.length) && !modalOpen,
      canOpenSettings: !modalOpen,
      canCreateSession: canCreateSession && !modalOpen,
      canFocusComposer: canCreateSession && !modalOpen,
      canToggleNavigation: Boolean(projectId && !modalOpen),
      canUseWorkspace: canUseWorkspace && !modalOpen,
      navigationVisible: showNavigation,
      reviewVisible: reviewOpen,
      terminalVisible,
    });
  }, [api, opening, modalOpen, canCreateSession, projectId, projects?.length, canUseWorkspace, showNavigation, reviewOpen, terminalVisible]);

  const panelControls = project && <WorkspacePanelButtons reviewOpen={reviewOpen} terminalVisible={terminalVisible}
    disabled={Boolean(removingProject)} reviewTitle={`${reviewOpen ? 'Hide changes' : 'Show project changes'} (${modifier}${shift}D)`}
    terminalTitle={`${terminalVisible ? 'Hide terminal' : 'Show terminal'} (${isMac ? '⌘⇧T' : 'Ctrl+`'})`}
    onReview={toggleReview} onTerminal={toggleTerminal} />;

  return (
    <div className={`app${isMac ? ' app--mac' : ''}${dockedNavigation ? ' app--nav' : ''}${drawerOpen ? ' app--drawer' : ''}${toolsDocked ? ' app--tools-docked' : ''}`} ref={app}>
      <header className="titlebar" onKeyDown={(event) => {
        if (drawerOpen && event.key === 'Escape') closeDrawer(true);
      }}>
        <div className="titlebar-leading">
          {!project && <div className="wordmark"><Icon name="mark" /> Pideck</div>}
          {project && <button className="icon-button panel-toggle" id="toggle-navigation" type="button"
            aria-label={showNavigation ? 'Hide sidebar' : 'Show sidebar'} aria-controls={showNavigation ? 'workspace-navigation' : undefined}
            title={`${showNavigation ? 'Hide' : 'Show'} sidebar (${modifier}${shift}B)`} aria-expanded={showNavigation}
            onClick={toggleNavigation}><Icon name="sidebar" /></button>}
        </div>
        <div className="titlebar-content">
          <div className="title-context">
            {project && <div className="workspace-title">
              {!showNavigation && session && <span className="workspace-title-project" title={project.directory}>{project.name}</span>}
              {session ? renaming?.sessionId === session.id && renaming.source === 'titlebar'
                ? <SessionName key={session.id} title={session.title} onFinish={finishRename} />
                : <button type="button" className="workspace-title-current session-title-button" id="rename-current-session"
                    title={`Rename session “${session.title}”`} aria-label={`Rename session ${session.title}`}
                    onClick={() => setRenaming({ projectId: project.id, sessionId: session.id, source: 'titlebar' })}>
                    {session.title}
                  </button>
                : <span className="workspace-title-current" title={project.directory}>{project.name}</span>}
            </div>}
          </div>
          {panelControls}
        </div>
      </header>
      <div className="app-body">
        {drawerOpen && <div className="navigation-scrim" aria-hidden="true" onClick={() => closeDrawer(true)} />}
        {project && showNavigation && (
          <aside className="navigation" id="workspace-navigation" ref={navigationPanel} aria-label="Workspace navigation"
            onKeyDown={(event) => {
              if (drawerOpen && event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault();
                closeDrawer(true);
              }
            }}>
            <div className="nav-header">
              <h2 id="nav-projects-label">Projects</h2>
              <div className="nav-header-actions">
                <button className="icon-button" id="nav-search-sessions" type="button" aria-label="Search sessions"
                  title={`Search sessions (${modifier}K)`} onClick={openSessionSearch}><Icon name="search" /></button>
                <button className="icon-button" id="nav-open-project" type="button" aria-label="Open folder…"
                  title={`Open folder (${modifier}O)`} disabled={opening} onClick={openProject}><Icon name="plus" /></button>
              </div>
            </div>
            <nav className="nav-scroll" aria-labelledby="nav-projects-label" aria-busy={Boolean(removing)} onKeyDown={navigateRows}>
              <ul className="nav-tree">
                {projects?.map((item) => {
                  const id = item.id;
                  const active = id === projectId;
                  const expanded = isExpanded(id);
                  const branch = sessionLists[id];
                  const branchId = `nav-sessions-${id}`;
                  const pending = drafts[id]?.[newSessionDraft];
                  const unsent = Boolean(pending?.text.trim() || pending?.attachments.length);
                  const setExpanded = (value: boolean) => setProjectExpansion(current => ({ ...current, [id]: value }));
                  return <li className="nav-project-node" key={id}>
                    <div className="nav-item nav-project-row" data-active={active || undefined}>
                      <button className="icon-button nav-disclosure" type="button"
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name}`} aria-expanded={expanded}
                        aria-controls={expanded ? branchId : undefined} onClick={() => setExpanded(!expanded)}>
                        <Icon name="chevron" width={14} height={14} />
                      </button>
                      <button className="nav-row" id={`nav-project-${id}`} type="button" title={item.directory}
                        aria-description={item.directory} aria-current={active && (!expanded || !sessionId) ? 'true' : undefined}
                        aria-keyshortcuts="ArrowLeft ArrowRight Delete Backspace ContextMenu Shift+F10"
                        onContextMenu={event => navigationContext(event, { projectId: id }, item.name)}
                        onKeyDown={(event) => {
                          if (navigationAction(event, { projectId: id }, item.name)) return;
                          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                          event.preventDefault();
                          if (event.key === 'ArrowRight' && expanded) {
                            document.getElementById(branchId)?.querySelector<HTMLButtonElement>('.nav-session-row')?.focus();
                          } else setExpanded(event.key === 'ArrowRight');
                        }}
                        onClick={() => {
                          selectProject(id);
                          revealConversation(id);
                          if (drawerOpen) {
                            closeDrawer();
                            setFocusWorkspace(id);
                          }
                        }}><span>{item.name}</span></button>
                      <button className="icon-button nav-new-session" type="button"
                        data-draft={unsent || undefined} aria-label={`${unsent ? 'Resume unsent draft in' : 'New session in'} ${item.name}`}
                        title={unsent ? 'Resume unsent draft' : 'New session'}
                        disabled={removing?.projectId === id && !removing.sessionId} onClick={() => openSessionDraft(id)}>
                        {unsent ? 'Draft' : <Icon name="plus" width={14} height={14} />}
                      </button>
                    </div>
                    {expanded && <ul className="nav-children" id={branchId} aria-label={`${item.name} sessions`}>
                      {branch && sessionTree(branch).map(({ session: chat, depth, hasChildren, parentId }) => {
                        const indent = Math.min(depth, 8) * 12;
                        const current = active && chat.id === sessionId;
                        const draft = drafts[id]?.[chat.id];
                        const hasDraft = Boolean(draft?.text || draft?.attachments.length);
                        const activity = sessionActivity[chat.id];
                        const status = activity ? activityLabels[activity.state] : hasDraft ? 'Unsent draft' : undefined;
                        return <li className="nav-item nav-session-item" key={chat.id} data-parent-session={parentId}
                          style={{ paddingInlineStart: indent }}>
                          {depth > 0 && <span className="nav-session-guides" aria-hidden="true" style={{ width: indent }} />}
                          {renaming?.sessionId === chat.id && renaming.source === 'sidebar'
                            ? <SessionName title={chat.title} onFinish={finishRename} />
                            : <button className="nav-row nav-session-row" id={`nav-session-${chat.id}`} type="button"
                              title={dockedNavigation ? `${chat.title} · Double-click or press F2 to rename` : chat.title}
                              aria-current={current ? 'true' : undefined} aria-keyshortcuts="F2 ArrowLeft ArrowRight Delete Backspace ContextMenu Shift+F10"
                              onContextMenu={event => navigationContext(event, { projectId: id, sessionId: chat.id }, chat.title)}
                              aria-description={[parentId && `Branch of ${branch.find(item => item.id === parentId)?.title}`, status].filter(Boolean).join(' · ') || undefined}
                              onKeyDown={(event) => {
                                if (navigationAction(event, { projectId: id, sessionId: chat.id }, chat.title)) return;
                                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                                if (event.key === 'ArrowLeft') {
                                  event.preventDefault();
                                  document.getElementById(parentId ? `nav-session-${parentId}` : `nav-project-${id}`)?.focus();
                                } else if (event.key === 'ArrowRight' && hasChildren) {
                                  event.preventDefault();
                                  document.getElementById(`nav-session-${branch.find(item => item.parentSessionId === chat.id)?.id}`)?.focus();
                                } else if (event.key === 'F2' && !removing) {
                                  event.preventDefault();
                                  setRenaming({ projectId: id, sessionId: chat.id, source: 'sidebar' });
                                }
                              }}
                              onDoubleClick={dockedNavigation && !removing
                                ? () => setRenaming({ projectId: id, sessionId: chat.id, source: 'sidebar' }) : undefined}
                              onClick={() => {
                                selectProject(id);
                                selectSession(id, chat.id);
                                revealConversation(id);
                                if (drawerOpen) {
                                  closeDrawer();
                                  setFocusedSession({ projectId: id, sessionId: chat.id });
                                }
                              }}>
                              <span>{chat.title}</span>
                              {status && <span className="nav-session-status" data-activity={activity?.state} title={status} aria-hidden="true">
                                <Icon name={activity ? activityIcons[activity.state] : 'edit'} width={14} height={14} />
                              </span>}
                            </button>}
                        </li>;
                      })}
                      {sessionErrors[id] ? <li className="nav-empty"><span role="alert">Could not load sessions.</span> <button className="inline-action"
                        type="button" onClick={() => refreshSessions((current) => current + 1)}>Retry</button></li>
                        : !branch ? <li className="nav-empty"><span role="status">Loading sessions…</span></li> : null}
                    </ul>}
                  </li>;
                })}
              </ul>
              {projectsError && <p className="nav-empty" role="alert">Could not refresh projects. <button className="inline-action"
                type="button" onClick={() => refreshWorkspace((current) => current + 1)}>Retry</button></p>}
            </nav>
            {showProviders && <div className="nav-footer">
              <button className="nav-row" type="button" title={`Model providers (${modifier},)`} onClick={() => setSettings({})}>
                <Icon name="settings" /><span>Model providers</span>
              </button>
            </div>}
          </aside>
        )}
        <NavigationDivider sizingTarget={app} visible={dockedNavigation} preferred={preferences.navigationWidth}
          onResize={navigationWidth => setPreferences(current => current.navigationWidth === navigationWidth
            ? current : { ...current, navigationWidth })} />
        <section className={`workspace${toolsDocked ? ' workspace--tools-docked' : ''}${toolsOverlay ? ' workspace--tools-overlay' : ''}`} aria-label="Workspace"
          ref={workspace} inert={drawerOpen}>
          {error && <div className="notice" id="workspace-notice" tabIndex={-1} role="alert"><Icon name="alert" /><span>{error}</span>
            <button className="icon-button" type="button" aria-label="Dismiss message" onClick={() => setError(undefined)}><Icon name="close" /></button>
          </div>}
          {blockingBranches.length > 0 && removalBlock && <div className="notice notice--info removal-branches" id="removal-branches" tabIndex={-1}>
            <Icon name="fork" />
            <div>
              <span role="alert">Remove this session’s branches first.</span>
              <ul aria-label="Branches to remove">
                {blockingBranches.map(branch => <li key={branch.id}>
                  <button className="inline-action" type="button" disabled={!branch.ready} aria-label={`Open branch ${branch.title}`} onClick={() => {
                    const id = removalBlock.target.projectId;
                    selectProject(id);
                    selectSession(id, branch.id);
                    revealConversation(id);
                    setFocusedSession({ projectId: id, sessionId: branch.id });
                  }}>{branch.title}</button>
                </li>)}
              </ul>
            </div>
            <button className="icon-button" type="button" aria-label="Dismiss branches" onClick={() => setRemovalBlock(undefined)}>
              <Icon name="close" />
            </button>
          </div>}
          <div className="workspace-main">
            <div className="workspace-conversation" inert={toolsOverlay}>
              {!project
                ? projectsError
                  ? <EmptyScene icon="folderPlus" title="Couldn’t load projects">
                      <p role="alert">{projectsError}</p>
                      <button className="button button--primary" type="button"
                        disabled={recoveringHost} onClick={() => void recoverHost()}>Retry loading projects</button>
                    </EmptyScene>
                  : !projects
                    ? <div className="workspace-loading" role="status">Opening workspace…</div>
                    : <EmptyScene icon="mark" title="Open a project folder">
                        <p>Choose a local codebase to start working with Pideck.</p>
                        <button className="button button--primary" id="workspace-open-project" type="button"
                          title={`Open folder (${modifier}O)`} disabled={opening} onClick={openProject}>
                          <Icon name="folderPlus" /> {opening ? 'Opening…' : 'Open folder'}
                        </button>
                      </EmptyScene>
                : sessions
                  ? <Chat key={`${project.id}/${draftId}/${resultNavigation}`} project={project} session={session} models={models}
                      modelsReady={modelsReady} modelsError={modelsError} defaultModel={preferences.model}
                      savedConnectionsPending={savedConnectionsPending} onLoadSavedModels={loadSavedModels}
                      draft={projectDrafts?.[draftId] ?? emptyDraft} updateDraft={updateActiveDraft}
                      activityReceipt={!toolsOverlay && !drawerOpen && !nativeModalOpen && sessionId ? sessionActivity[sessionId] : undefined}
                      readingPosition={session ? preferences.reading[project.id]?.[session.id] : undefined} onReadingPosition={rememberReadingPosition}
                      onModelChosen={(model) => setPreferences((current) => ({ ...current, model }))}
                      onRetryModels={() => refreshModels((current) => current + 1)}
                      onSettings={(provider) => setSettings({ provider })}
                      onReview={openReview} onWorkspaceChange={refreshReview}
                      onSent={() => refreshSessions((current) => current + 1)} onStarted={attachStartedSession} onFork={forkSession} />
                  : sessionsIssue
                    ? <EmptyScene icon="chat" title="Couldn’t load sessions">
                        <p role="alert">{sessionsIssue}</p>
                        <button className="button button--primary" type="button"
                          disabled={recoveringHost} onClick={() => void recoverHost()}>Retry loading sessions</button>
                      </EmptyScene>
                    : <div className="workspace-loading" role="status">Loading sessions…</div>}
            </div>
            <div className="workspace-tools" id="workspace-tools" hidden={!toolsOpen} data-docked={toolsDocked || undefined}>
              {project && activeReview && <Suspense key={`review:${project.id}`} fallback={reviewOpen && <div className="panel-loading panel-loading--review" role="status">Opening review…</div>}>
                <ReviewPanel project={project} visible={reviewOpen} overlay={reviewOverlaysChat} selectedPath={activeReview.path} selectedPatch={activeReview.patch} selectedLine={activeReview.line}
                  onSelectWorkingTreeFile={selectWorkingTreeFile}
                  rememberedPath={preferences.reviewPaths[project.id]} onRememberPath={rememberReviewPath}
                  refreshVersion={reviewVersion} selectionVersion={activeReview.selection} onClose={closeReview} />
              </Suspense>}
              {projects?.filter((item) => Object.hasOwn(terminals, item.id)).map((item) => {
                const visible = item.id === projectId && terminalVisible;
                return <Suspense key={item.id} fallback={visible && <div className="panel-loading panel-loading--terminal" role="status">Opening terminal…</div>}>
                  <TerminalPanel project={item} visible={visible} overlay={visible && terminalOverlaysChat} focusOnShow={focusTerminal === item.id}
                    onClose={() => closeTerminal(item.id)} onExit={closeTerminal} />
                </Suspense>;
              })}
            </div>
          </div>
          <WorkspaceDivider workspace={workspace} sizingTarget={app} visible={toolsDocked} />
        </section>
      </div>
      {navigationMenu && <NavigationMenu target={navigationMenu} onClose={closeNavigationMenu} onRemove={() => {
        setNavigationMenu(undefined);
        void remove(navigationMenu.selection, navigationMenu.trigger);
      }} />}
      {searching && projects && <SessionSearch projects={projects} sessions={sessionLists} errors={sessionErrors}
        onSelect={openSearchResult} onRetry={() => refreshSessions(current => current + 1)} onClose={() => setSearching(false)} />}
      {settings && <SettingsDialog initialProvider={settings.provider} onClose={() => setSettings(undefined)}
        onModelsChanged={() => refreshModels((current) => current + 1)} />}
    </div>
  );
}

export function App() {
  if (!window.pideck) return (
    <div className="app">
      <EmptyScene icon="mark" title="Open the desktop app">
        <p>Launch Pideck to connect to your projects and conversations.</p>
      </EmptyScene>
    </div>
  );
  return <RestoredDesktop />;
}

function RestoredDesktop() {
  const [drafts, setDrafts] = useState<ReturnType<typeof readDrafts>>();
  useEffect(() => {
    let active = true;
    void hydrateDraftImages(readDrafts(), window.pideck).then(value => { if (active) setDrafts(value); });
    return () => { active = false; };
  }, []);
  return drafts ? <Desktop initialDrafts={drafts} />
    : <div className="app"><div className="workspace-loading" role="status">Restoring workspace…</div></div>;
}
