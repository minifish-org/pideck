import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, type FileDiffOptions } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project, ReviewFile, ReviewPatch } from "../shared/api";
import { Icon } from "./Icons";
import "./workspace.css";

type DiffStyle = "unified" | "split";
type DiffLayout = "auto" | DiffStyle;
const splitMinimumWidth = 700;
const workerOptions = { workerFactory: () => new DiffWorker(), poolSize: 1, mainThreadMaxCharacters: 12_000 };
const highlighterOptions = {
  theme: "github-dark-default", preferredHighlighter: "shiki-js", lineDiffType: "word-alt", tokenizeMaxLineLength: 2_000,
} as const;
const diffOptions: FileDiffOptions<undefined, undefined> = {
  ...highlighterOptions,
  themeType: "dark",
  enableLineSelection: true,
  hunkSeparators: "line-info",
  maxLineDiffLength: 300,
};
let patchId = 0;

function usePatch(patch: string | null | undefined) {
  return useMemo(() => {
    if (!patch || patch.length > 512 * 1024) return [];
    try {
      return parsePatchFiles(patch, {
        cacheKeyPrefix: `pideck-${++patchId}`, throwOnError: true,
        disableLineMatching: patch.split("\n", 5_001).length > 5_000,
      })
        .flatMap(parsed => parsed.files);
    } catch {
      return [];
    }
  }, [patch]);
}

function PatchView({ patch, files, style, wrap }: { patch: string; files: FileDiffMetadata[]; style: DiffStyle; wrap: boolean }) {
  if (files.length === 0 || files.every(file => file.hunks.length === 0)) {
    return <pre className="workspace-raw-patch">{patch}</pre>;
  }
  return files.map((file, index) => <FileDiff key={file.cacheKey ?? index} fileDiff={file} className="workspace-diff" options={{
    ...diffOptions,
    diffStyle: style,
    overflow: wrap ? "wrap" : "scroll",
    disableFileHeader: files.length === 1,
  }} />);
}

function ChangeCount({ files }: { files: FileDiffMetadata[] }) {
  let added = 0;
  let removed = 0;
  for (const { hunks } of files) for (const hunk of hunks) {
    added += hunk.additionLines;
    removed += hunk.deletionLines;
  }
  if (!added && !removed) return null;
  return <span className="workspace-change-count" role="group" aria-label={`${added} added, ${removed} removed`}>
    <span>+{added}</span> <span>−{removed}</span>
  </span>;
}

export function InlineDiff({ patch, onOpen }: { patch: string; onOpen: () => void }) {
  const isSmall = patch.length <= 16_384 && patch.split("\n", 46).length <= 45;
  if (!isSmall) {
    return <button type="button" className="workspace-inline-open" onClick={onOpen}>
      Open in Changes <ArrowUpRight size={13} aria-hidden="true" />
    </button>;
  }
  return <InlinePatch patch={patch} />;
}

function InlinePatch({ patch }: { patch: string }) {
  const files = usePatch(patch);
  return <div className="workspace-inline">
    <div className="workspace-inline-header"><ChangeCount files={files} /></div>
    <div className="workspace-inline-scroll"><PatchView patch={patch} files={files} style="unified" wrap={false} /></div>
  </div>;
}

type ReviewPanelProps = {
  project: Project;
  visible: boolean;
  overlay: boolean;
  onClose: () => void;
  selectedPath?: string;
  selectedPatch?: string;
  onSelectWorkingTreeFile: (path: string) => void;
  rememberedPath?: string;
  onRememberPath?: (path: string | undefined) => void;
  refreshVersion?: number;
  selectionVersion?: number;
};
function ReviewIssue({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="workspace-empty workspace-review-issue">
    <span role="alert">{message}</span>
    <button type="button" className="workspace-action" onClick={onRetry}>Retry</button>
  </div>;
}

export function ReviewPanel(props: ReviewPanelProps) {
  return <ProjectReview key={props.project.id} {...props} />;
}

function ProjectReview({ project, visible, overlay, onClose, selectedPath, selectedPatch, onSelectWorkingTreeFile,
  rememberedPath, onRememberPath, refreshVersion, selectionVersion }: ReviewPanelProps) {
  const requestedPath = normalizePath(project.directory, selectedPath);
  const showMessagePatch = Boolean(selectedPatch);
  const requestedGitPath = showMessagePatch ? undefined : requestedPath;
  const [path, setPath] = useState(requestedGitPath ?? rememberedPath);
  const lastSelection = useRef({ requestedPath, selectedPatch, selectionVersion });
  const [layout, setLayout] = useState<DiffLayout>("auto");
  const [wide, setWide] = useState(false);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [watchAttempt, setWatchAttempt] = useState(0);
  const [watchError, setWatchError] = useState(false);
  const [list, setList] = useState<{ files: ReviewFile[]; revision: number; error?: string }>();
  const [result, setResult] = useState<{ revision: number; path: string; value?: ReviewPatch; error?: string }>();
  const panel = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const watchReady = useRef(false);
  const diffScroll = useRef<{ key: string; top: number } | undefined>(undefined);
  const lastRefreshVersion = useRef(refreshVersion);
  const style = layout === "auto" ? (wide ? "split" : "unified") : layout;
  const files = list?.files ?? [];
  const messagePath = requestedPath ?? "Edit patch";
  const listReady = list?.revision === revision;
  const selectedFile = files.find(candidate => candidate.path === path);
  const missingRequestedFile = list && !list.error && !selectedFile && requestedGitPath !== undefined && requestedGitPath === path;
  const file = showMessagePatch || missingRequestedFile ? undefined : selectedFile ?? files[0];
  const currentPath = file?.path;
  const currentResult = result?.path === currentPath ? result : undefined;
  const patch = showMessagePatch ? selectedPatch : currentResult?.value?.patch;
  const parsed = usePatch(patch);
  const query = filter.trim().toLocaleLowerCase();
  const visibleFiles = files.filter(candidate => !query || candidate.path.toLocaleLowerCase().includes(query));
  const fileTabStop = visibleFiles.find(candidate => candidate.path === currentPath) ?? visibleFiles[0];
  const displayedPath = showMessagePatch ? messagePath : currentPath ?? (missingRequestedFile ? requestedGitPath : undefined);
  const diffKey = showMessagePatch ? `chat-${selectionVersion}-${displayedPath}` : `git-${displayedPath}`;
  const refresh = useCallback(() => setRefreshRequested(true), []);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth > 0) setWide(element.clientWidth >= splitMinimumWidth);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const saved = diffScroll.current;
    if (saved?.key !== diffKey) {
      diffScroll.current = undefined;
      return;
    }
    if (!visible) return;
    const scroller = panel.current?.querySelector<HTMLElement>(".workspace-review-scroll");
    if (scroller) scroller.scrollTop = saved.top;
  }, [diffKey, visible]);

  useEffect(() => {
    const last = lastSelection.current;
    if (last.requestedPath === requestedPath && last.selectedPatch === selectedPatch && last.selectionVersion === selectionVersion) return;
    lastSelection.current = { requestedPath, selectedPatch, selectionVersion };
    setPath(requestedGitPath ?? rememberedPath);
    setFilter("");
  }, [rememberedPath, requestedGitPath, requestedPath, selectedPatch, selectionVersion]);

  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    if (!visible) return;
    const timer = window.setTimeout(refresh, 140);
    return () => window.clearTimeout(timer);
  }, [refresh, refreshVersion, visible]);

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, visible]);

  useEffect(() => {
    if (!visible || !project.trusted) return;
    const api = window.pideck;
    const scope = { projectId: project.id, subscriptionId: crypto.randomUUID() };
    let active = true;
    const started = () => {
      if (!active) return;
      watchReady.current = true;
      setRefreshRequested(false);
      setRevision(value => value + 1);
    };
    const failed = () => {
      if (active) setWatchError(true);
    };
    setWatchError(false);
    const unsubscribe = api.onEvent(event => {
      if (event.type === "host:restart") setWatchAttempt(attempt => attempt + 1);
      if (event.type === "host:disconnected") failed();
      if ((event.type === "review:changed" || event.type === "review:watch-error")
        && event.subscriptionId === scope.subscriptionId && event.projectId === scope.projectId) {
        if (event.type === "review:changed") refresh();
        else failed();
      }
    });
    void api.invoke("review:watch", scope).then(started, () => {
      failed();
      started();
    });
    return () => {
      active = false;
      watchReady.current = false;
      unsubscribe();
      void api.invoke("review:unwatch", scope).catch(() => {});
    };
  }, [project.id, project.trusted, refresh, visible, watchAttempt]);

  useEffect(() => {
    if (visible && (overlay || selectionVersion !== undefined) && !panel.current?.contains(document.activeElement)) {
      panel.current?.focus({ preventScroll: true });
    }
  }, [overlay, selectionVersion, visible]);

  useEffect(() => {
    if (!visible || !project.trusted || !watchReady.current) return;
    let active = true;
    void window.pideck.invoke("review:list", { projectId: project.id }).then(
      next => { if (active) setList({ files: next, revision }); },
      cause => { if (active) setList(previous => ({ files: previous?.files ?? [], revision, error: message(cause) })); },
    );
    return () => { active = false; };
  }, [project.id, project.trusted, revision, visible]);

  useEffect(() => {
    if (!listReady || !list || list.error) return;
    setPath(current => current !== undefined && current !== requestedGitPath
      && !list.files.some(candidate => candidate.path === current) ? undefined : current);
  }, [list, listReady, requestedGitPath]);

  useEffect(() => {
    if (listReady && !list?.error && !showMessagePatch && !missingRequestedFile) onRememberPath?.(currentPath);
  }, [currentPath, list?.error, listReady, missingRequestedFile, onRememberPath, showMessagePatch]);

  useEffect(() => {
    if (!visible || !project.trusted || !watchReady.current || !listReady || !currentPath || list?.error) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.pideck.invoke("review:patch", { projectId: project.id, path: currentPath }).then(
        value => { if (active) setResult({ revision, path: currentPath, value }); },
        cause => { if (active) setResult({ revision, path: currentPath, error: message(cause) }); },
      );
    }, 70);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [project.id, project.trusted, currentPath, listReady, list?.error, revision, visible]);

  const loading = !listReady || Boolean(currentPath && !list?.error
    && (result?.path !== currentPath || result.revision !== revision));
  const readingDiff = loading && currentPath !== undefined && !currentResult;
  useEffect(() => {
    if (!visible || !watchReady.current || loading || !refreshRequested) return;
    // Finish the current snapshot before reading again after another filesystem event.
    setRefreshRequested(false);
    setRevision(value => value + 1);
  }, [loading, refreshRequested, visible]);

  function retryReview() {
    panel.current?.focus({ preventScroll: true });
    if (watchError) setWatchAttempt(attempt => attempt + 1);
    else refresh();
  }

  const showFileList = files.length > 1 || (files.length > 0 && (showMessagePatch || missingRequestedFile)) || Boolean(filter);
  const showSelectionInList = showFileList && visibleFiles.some(candidate => candidate.path === currentPath);
  const layoutControl = parsed.some(item => item.hunks.length > 0) && <div className="workspace-layout">
    <select aria-label="Diff layout" title="Diff layout" value={layout}
      onChange={event => setLayout(event.target.value as DiffLayout)}>
      <option value="auto">Auto layout</option>
      <option value="unified">Unified</option>
      <option value="split">Side by side</option>
    </select>
    <Icon name="down" width={12} height={12} />
  </div>;
  return <aside className="workspace-review" id="review-panel" ref={panel} tabIndex={-1} aria-label="Review changes"
    hidden={!visible} data-overlay={overlay || undefined} onScrollCapture={event => {
      if (visible && event.target instanceof HTMLElement && event.target.classList.contains("workspace-review-scroll")) {
        diffScroll.current = { key: diffKey, top: event.target.scrollTop };
      }
    }} onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement && filter) setFilter("");
    else onClose();
  }}>
    <header className="workspace-panel-header">
      {overlay && <button type="button" className="workspace-icon-button workspace-back" onClick={onClose}
        aria-label="Back to chat" title="Back to chat (Esc)"><ArrowLeft size={17} aria-hidden="true" /></button>}
      <h2>Changes</h2>
      {files.length > 0 && <span className="workspace-panel-meta">{files.length} {files.length === 1 ? "file" : "files"}</span>}
      {showSelectionInList && <><ChangeCount files={parsed} />{layoutControl}</>}
    </header>
    {!project.trusted ? <p className="workspace-empty">Trust this project to review its changes.</p>
      : !list && !showMessagePatch ? <p className="workspace-empty" role="status">Reading changes…</p>
      : <>
        {(list?.error || (watchError && !currentResult?.error)) && <ReviewIssue
          message={list?.error ?? "Automatic updates are unavailable."} onRetry={retryReview} />}
        {showFileList && (files.length > 7 || filter) && <div className="workspace-file-filter">
          <input type="search" value={filter} placeholder="Filter changed files…" aria-label="Filter changed files"
            onChange={event => setFilter(event.target.value)} onKeyDown={event => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                nav.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
              }
            }} />
        </div>}
        {showFileList && <nav className="workspace-file-list" aria-label="Changed files" ref={nav} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = Array.from(event.currentTarget.querySelectorAll("button"));
          const index = items.findIndex(item => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
          event.preventDefault();
          items[next]?.focus();
          items[next]?.click();
        }}>
          {visibleFiles.map(candidate => {
            const selected = candidate.path === currentPath;
            const label = fileDescription(candidate);
            return <button key={candidate.path} type="button" title={label} aria-label={label}
              tabIndex={candidate === fileTabStop ? 0 : -1}
              aria-current={selected ? "true" : undefined} onClick={() => {
                if (showMessagePatch) {
                  if (files.length === 1) panel.current?.focus({ preventScroll: true });
                  onSelectWorkingTreeFile(candidate.path);
                }
                setPath(candidate.path);
              }}>
              <Icon name="file" className="workspace-file-icon" />
              <FileLabel path={candidate.path} />
              <FileStatus status={candidate.status} />
            </button>;
          })}
          {query && visibleFiles.length === 0 && <p className="workspace-filter-empty">No matching paths.</p>}
        </nav>}
        {displayedPath ? <>
          {!showSelectionInList && <div className="workspace-diff-header">
            <h3 title={showMessagePatch ? `Patch from chat for ${messagePath}` : file ? fileDescription(file) : displayedPath}
              aria-description={file ? fileStatus(file.status) : undefined}>
              <Icon name="file" className="workspace-file-icon" />
              <FileLabel path={displayedPath} />
              {file && !showFileList && <FileStatus status={file.status} />}
            </h3>
            {showMessagePatch && <span className="workspace-panel-meta">From chat</span>}
            <ChangeCount files={parsed} />
            {layoutControl}
          </div>}
          {patch ? <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
            <Virtualizer key={diffKey} className="workspace-review-scroll">
              <PatchView patch={patch} files={parsed} style={style} wrap />
            </Virtualizer>
          </WorkerPoolContextProvider> : !list?.error && <div className="workspace-review-scroll">
            {currentResult?.error ? <ReviewIssue message={currentResult.error} onRetry={retryReview} />
              : <p className="workspace-empty" role={readingDiff ? "status" : undefined}>
                {readingDiff ? "Reading diff…" : currentResult?.value?.reason ?? "This file has no current Git changes."}
              </p>}
          </div>}
        </> : !list?.error && <p className="workspace-empty">No Git changes in this project.</p>}
      </>}
  </aside>;
}

function FileStatus({ status }: { status: string }) {
  const code = status.trim();
  return <span className="workspace-file-status" data-status={code[0]} aria-hidden="true">{code}</span>;
}

function FileLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const folder = slash > 0 ? path.slice(0, slash) : "";
  return <span className="workspace-file-label">
    <span className="workspace-file-name">{path.slice(slash + 1)}</span>
    {folder && <span className="workspace-file-detail">{folder}</span>}
  </span>;
}

function normalizePath(directory: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const windows = window.pideck.platform === "win32";
  const format = (value: string) => windows ? value.replaceAll("\\", "/") : value;
  const root = format(directory).replace(/\/$/, "") + "/";
  const value = format(path);
  const scoped = (windows ? value.toLowerCase().startsWith(root.toLowerCase()) : value.startsWith(root))
    ? value.slice(root.length) : value;
  return scoped.replace(/^(?:\.\/)+/, "");
}

function fileDescription({ path, oldPath, status }: ReviewFile) {
  return `${oldPath ? `${oldPath} → ` : ""}${path} · ${fileStatus(status)}`;
}

function fileStatus(status: string) {
  if (status === "??") return "Untracked";
  if (/U|AA|DD/.test(status)) return "Merge conflict";
  const [index, worktree] = status;
  const labels: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", "?": "Untracked" };
  return [labels[index] && `Staged ${labels[index].toLowerCase()}`,
    labels[worktree] && `Working tree ${labels[worktree].toLowerCase()}`].filter(Boolean).join(" · ");
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unable to load the project's changes.";
}
