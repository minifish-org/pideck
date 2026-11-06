import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, type FileDiffOptions } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { RefreshCw, WrapText } from "lucide-react";
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
  return <span className="workspace-change-count" aria-label={`${added} added, ${removed} removed`}>
    <span>+{added}</span> <span>−{removed}</span>
  </span>;
}

export function InlineDiff({ patch, onOpen }: { patch: string; onOpen?: () => void }) {
  const isSmall = patch.length <= 16_384 && patch.split("\n", 46).length <= 45;
  if (!isSmall && onOpen) {
    return <div className="workspace-inline workspace-inline-large">
      <span>File changes</span>
      <button type="button" className="workspace-action" onClick={onOpen}>Open review <span aria-hidden="true">↗</span></button>
    </div>;
  }
  return <InlinePatch patch={patch} open={isSmall} onOpen={onOpen} />;
}

function InlinePatch({ patch, open, onOpen }: { patch: string; open: boolean; onOpen?: () => void }) {
  const files = usePatch(patch);
  return <details className="workspace-inline" open={open}>
    <summary>Changes <ChangeCount files={files} /></summary>
    <div className="workspace-inline-scroll"><PatchView patch={patch} files={files} style="unified" wrap={false} /></div>
    {onOpen && <button type="button" className="workspace-inline-open" onClick={onOpen}>Open review <span aria-hidden="true">↗</span></button>}
  </details>;
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
  const displayedPath = currentPath ?? (showEdit ? editPath : typeof path === "string" ? path : undefined);
  return <aside className="workspace-review" aria-label="Review changes" onKeyDown={event => {
    if (event.key === "Escape" && !(event.target instanceof HTMLInputElement)) onClose();
  }}>
    <header className="workspace-panel-header">
      <h2>Changes</h2>
      <span className="workspace-count">{files.length}</span>
      {loading && list && <span className="workspace-refresh-status" role="status">Refreshing…</span>}
      <button type="button" className="workspace-icon-button workspace-refresh" onClick={() => setRevision(value => value + 1)}
        disabled={!project.trusted || !listReady} aria-label="Refresh changes" title="Refresh changes"><RefreshCw size={15} aria-hidden="true" /></button>
      <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close review" title="Close review"><Icon name="close" /></button>
    </header>
    {!project.trusted ? <p className="workspace-empty">Trust this project to review its changes.</p>
      : !list && !selectedPatch ? <p className="workspace-empty" role="status">Reading changes…</p>
      : <>
        {list?.error && <p className="workspace-empty" role="alert">{list.error}</p>}
        {files.length > 7 && <div className="workspace-file-filter">
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
          {selectedPatch && <button type="button" title={`Assistant patch for ${editPath}`}
            aria-current={showEdit ? "true" : undefined} onClick={() => setPath(editSelection)}>
            <span className="workspace-file-status" data-status="E">Pi</span>
            <span>{editPath} <small>Assistant change</small></span>
          </button>}
          {visibleFiles.map(candidate => <button key={candidate.path} type="button"
            title={`${candidate.oldPath ? `${candidate.oldPath} → ` : ""}${candidate.path} · ${fileStatus(candidate.status)}`}
            aria-current={candidate.path === currentPath ? "true" : undefined} onClick={() => setPath(candidate.path)}>
            <span className="workspace-file-status" data-status={candidate.status.trim().slice(0, 1)}>{candidate.status.trim()}</span>
            <span>{candidate.path}</span>
          </button>)}
          {query && visibleFiles.length === 0 && <p className="workspace-filter-empty">No matching paths.</p>}
        </nav>}
        {displayedPath ? <>
          <div className="workspace-diff-toolbar">
            <span title={displayedPath}>{displayedPath}</span>
            <ChangeCount files={parsed} />
            <button type="button" className="workspace-icon-button" aria-pressed={wrap} aria-label="Wrap diff lines" title="Wrap diff lines"
              onClick={() => setWrap(value => !value)}><WrapText size={15} aria-hidden="true" /></button>
            <div className="workspace-segmented" role="group" aria-label="Diff layout">
              <button type="button" aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>Unified</button>
              <button type="button" aria-pressed={style === "split"} onClick={() => setStyle("split")}>Split</button>
            </div>
          </div>
          {patch ? <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
            <Virtualizer key={`${showEdit ? "assistant" : "git"}-${displayedPath}`} className="workspace-review-scroll">
              <PatchView patch={patch} files={parsed} style={style} wrap={wrap} />
            </Virtualizer>
          </WorkerPoolContextProvider> : <div className="workspace-review-scroll">
            <p className="workspace-empty" role={loading ? "status" : undefined}>
              {loading ? "Reading diff…" : currentResult?.reason ?? "This file has no current Git change."}
            </p>
          </div>}
        </> : !list?.error && <p className="workspace-empty">No Git changes in this project.</p>}
      </>}
  </aside>;
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
