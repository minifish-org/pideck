import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, type FileDiffOptions } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { ArrowUpRight, RefreshCw, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, ReviewFile, ReviewPatch } from "../shared/api";
import { Icon } from "./Icons";
import "./workspace.css";

type DiffStyle = "unified" | "split";
const workerOptions = { workerFactory: () => new DiffWorker(), poolSize: 1, mainThreadMaxCharacters: 12_000 };
const highlighterOptions = {
  theme: "pierre-dark", preferredHighlighter: "shiki-js", lineDiffType: "word-alt", tokenizeMaxLineLength: 2_000,
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

export function InlineDiff({ patch, onOpen }: { patch: string; onOpen?: () => void }) {
  const isSmall = patch.length <= 16_384 && patch.split("\n", 46).length <= 45;
  if (!isSmall && onOpen) {
    return <button type="button" className="workspace-inline-open" onClick={onOpen}>
      Open review <ArrowUpRight size={13} aria-hidden="true" />
    </button>;
  }
  return <InlinePatch patch={patch} onOpen={onOpen} />;
}

function InlinePatch({ patch, onOpen }: { patch: string; onOpen?: () => void }) {
  const files = usePatch(patch);
  return <div className="workspace-inline">
    <div className="workspace-inline-header">
      <ChangeCount files={files} />
      {onOpen && <button type="button" className="workspace-inline-open" onClick={onOpen}>
        Open review <ArrowUpRight size={13} aria-hidden="true" />
      </button>}
    </div>
    <div className="workspace-inline-scroll"><PatchView patch={patch} files={files} style="unified" wrap={false} /></div>
  </div>;
}

type ReviewPanelProps = {
  project: Project;
  onClose: () => void;
  selectedPath?: string;
  selectedPatch?: string;
  refreshVersion?: number;
  selectionVersion?: number;
};
const editSelection = Symbol("chat edit");

export function ReviewPanel(props: ReviewPanelProps) {
  return <ProjectReview key={props.project.id} {...props} />;
}

function ProjectReview({ project, onClose, selectedPath, selectedPatch, refreshVersion, selectionVersion }: ReviewPanelProps) {
  const requestedPath = normalizePath(project.directory, selectedPath);
  const initialPath = selectedPatch ? editSelection : requestedPath;
  const [path, setPath] = useState<string | symbol | undefined>(initialPath);
  const [style, setStyle] = useState<DiffStyle>("unified");
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{ files: ReviewFile[]; revision: number; error?: string }>();
  const [result, setResult] = useState<{ revision: number; path: string; value: ReviewPatch }>();
  const panel = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const lastRefreshVersion = useRef(refreshVersion);
  const files = list?.files ?? [];
  const editPath = requestedPath ?? "Edit patch";
  const showEdit = Boolean(selectedPatch && (path === editSelection || files.length === 0));
  const file = showEdit ? undefined : typeof path === "string" ? files.find(candidate => candidate.path === path) : files[0];
  const currentPath = file?.path;
  const listReady = list?.revision === revision;
  const currentResult = result?.path === currentPath ? result?.value : undefined;
  const patch = showEdit ? selectedPatch : currentResult?.patch;
  const parsed = usePatch(patch);
  const query = filter.trim().toLocaleLowerCase();
  const visibleFiles = files.filter(candidate => !query || candidate.path.toLocaleLowerCase().includes(query));

  useEffect(() => {
    setPath(initialPath);
    setFilter("");
  }, [initialPath, selectedPatch, selectionVersion]);

  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    const timer = window.setTimeout(() => setRevision(value => value + 1), 140);
    return () => window.clearTimeout(timer);
  }, [refreshVersion]);

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    const unsubscribe = window.pideck.onEvent(event => { if (event.type === "host:restart") refresh(); });
    return () => {
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const overlay = window.matchMedia("(max-width: 960px)");
    const focusOverlay = () => {
      if (overlay.matches && !panel.current?.contains(document.activeElement)) panel.current?.focus();
    };
    focusOverlay();
    overlay.addEventListener("change", focusOverlay);
    return () => overlay.removeEventListener("change", focusOverlay);
  }, []);

  useEffect(() => {
    if (!project.trusted) return;
    let active = true;
    void window.pideck.invoke("review:list", { projectId: project.id }).then(
      next => { if (active) setList({ files: next, revision }); },
      cause => { if (active) setList(previous => ({ files: previous?.files ?? [], revision, error: message(cause) })); },
    );
    return () => { active = false; };
  }, [project.id, project.trusted, revision]);

  useEffect(() => {
    if (!project.trusted || !listReady || !currentPath || list?.error) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.pideck.invoke("review:patch", { projectId: project.id, path: currentPath }).then(
        value => { if (active) setResult({ revision, path: currentPath, value }); },
        cause => { if (active) setResult({ revision, path: currentPath, value: { patch: null, reason: message(cause) } }); },
      );
    }, 70);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [project.id, project.trusted, currentPath, listReady, list?.error, revision]);

  const loading = !listReady || Boolean(currentPath && !list?.error
    && (result?.path !== currentPath || result.revision !== revision));
  const hasDiff = parsed.some(item => item.hunks.length > 0);
  const displayedPath = currentPath ?? (showEdit ? editPath : typeof path === "string" ? path : undefined);
  const selectionHidden = currentPath && !visibleFiles.some(candidate => candidate.path === currentPath);
  return <aside className="workspace-review" id="review-panel" ref={panel} tabIndex={-1} aria-label="Review changes" onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement && filter) setFilter("");
    else onClose();
  }}>
    <header className="workspace-panel-header">
      <h2>Changes</h2>
      {files.length > 0 && <span className="workspace-count" title={`${files.length} changed ${files.length === 1 ? "file" : "files"}`}>
        {files.length}
      </span>}
      {selectionHidden && <span className="workspace-review-selection" title={currentPath}>{currentPath}</span>}
      <div className="workspace-panel-actions">
        {displayedPath && <div className="workspace-segmented" role="group" aria-label="Diff layout">
          <button type="button" disabled={!hasDiff} aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>Unified</button>
          <button type="button" disabled={!hasDiff} aria-pressed={style === "split"} onClick={() => setStyle("split")}>Split</button>
        </div>}
        {displayedPath && <button type="button" className="workspace-icon-button" disabled={!hasDiff}
          aria-pressed={wrap} aria-label="Wrap diff lines" title="Wrap diff lines"
          onClick={() => setWrap(value => !value)}><WrapText size={15} aria-hidden="true" /></button>}
        <button type="button" className="workspace-icon-button" onClick={() => setRevision(value => value + 1)}
          disabled={!project.trusted || !listReady} aria-label="Refresh changes" title="Refresh changes">
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close review" title="Close review">
          <Icon name="close" />
        </button>
      </div>
    </header>
    {!project.trusted ? <p className="workspace-empty">Trust this project to review its changes.</p>
      : !list && !selectedPatch ? <p className="workspace-empty" role="status">Reading changes…</p>
      : <>
        {list?.error && <p className="workspace-empty" role="alert">{list.error}</p>}
        {(files.length > 7 || filter) && <div className="workspace-file-filter">
          <input type="search" value={filter} placeholder="Filter changed files…" aria-label="Filter changed files"
            onChange={event => setFilter(event.target.value)} onKeyDown={event => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                nav.current?.querySelector("button")?.focus();
              }
            }} />
        </div>}
        {(files.length > 0 || selectedPatch) && <nav className="workspace-file-list" aria-label="Changed files" ref={nav} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = Array.from(event.currentTarget.querySelectorAll("button"));
          const index = items.findIndex(item => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
          event.preventDefault();
          items[next]?.focus();
          items[next]?.click();
        }}>
          {selectedPatch && <button type="button" title={`Assistant patch for ${editPath}`} aria-label={`Assistant change for ${editPath}`}
            aria-current={showEdit ? "true" : undefined} onClick={() => setPath(editSelection)}>
            <Icon name="mark" className="workspace-file-icon workspace-file-icon--assistant" width={14} height={14} />
            <FileLabel path={editPath} context="Assistant change" />
            {showEdit && <ChangeCount files={parsed} />}
          </button>}
          {visibleFiles.map(candidate => {
            const status = candidate.status.trim();
            const selected = candidate.path === currentPath;
            const label = `${candidate.oldPath ? `${candidate.oldPath} → ` : ""}${candidate.path} · ${fileStatus(candidate.status)}`;
            return <button key={candidate.path} type="button" title={label} aria-label={label}
              aria-current={selected ? "true" : undefined} onClick={() => setPath(candidate.path)}>
              <Icon name="file" className="workspace-file-icon" width={14} height={14} />
              <FileLabel path={candidate.path} />
              {selected && <ChangeCount files={parsed} />}
              <span className="workspace-file-status" data-status={status[0]}>{status}</span>
            </button>;
          })}
          {query && visibleFiles.length === 0 && <p className="workspace-filter-empty">No matching paths.</p>}
        </nav>}
        {displayedPath ? <>
          {patch ? <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
            <Virtualizer key={`${showEdit ? "assistant" : "git"}-${displayedPath}`} className="workspace-review-scroll">
              <PatchView patch={patch} files={parsed} style={style} wrap={wrap} />
            </Virtualizer>
          </WorkerPoolContextProvider> : <div className="workspace-review-scroll">
            <p className="workspace-empty" role={loading ? "status" : undefined}>
              {loading ? "Reading diff…" : currentResult?.reason ?? <>No current changes in <code>{displayedPath}</code>.</>}
            </p>
          </div>}
        </> : !list?.error && <p className="workspace-empty">No Git changes in this project.</p>}
      </>}
  </aside>;
}

function FileLabel({ path, context }: { path: string; context?: string }) {
  const slash = path.lastIndexOf("/");
  const folder = slash > 0 ? path.slice(0, slash) : "";
  const detail = [context, folder].filter(Boolean).join(" · ");
  return <span className="workspace-file-label">
    <span className="workspace-file-name">{path.slice(slash + 1)}</span>
    {detail && <span className="workspace-file-detail">{detail}</span>}
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
