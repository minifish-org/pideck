import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, type FileDiffOptions } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project, ReviewFile, ReviewPatch } from "../shared/api";
import { Icon } from "./Icons";
import "./workspace.css";

type DiffStyle = "unified" | "split";
type DiffLayout = "auto" | DiffStyle;
const splitMinimumWidth = 700;
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
  overlay: boolean;
  onClose: () => void;
  selectedPath?: string;
  selectedPatch?: string;
  rememberedPath?: string;
  onRememberPath?: (path: string | undefined) => void;
  refreshVersion?: number;
  selectionVersion?: number;
};
const editSelection = Symbol("chat edit");

export function ReviewPanel(props: ReviewPanelProps) {
  return <ProjectReview key={props.project.id} {...props} />;
}

function ProjectReview({ project, overlay, onClose, selectedPath, selectedPatch, rememberedPath, onRememberPath,
  refreshVersion, selectionVersion }: ReviewPanelProps) {
  const requestedPath = normalizePath(project.directory, selectedPath);
  const requestedGitPath = selectedPatch ? undefined : requestedPath;
  const initialPath = selectedPatch ? editSelection : requestedPath;
  const [path, setPath] = useState<string | symbol | undefined>(initialPath ?? rememberedPath);
  const lastSelection = useRef({ initialPath, selectedPatch, selectionVersion });
  const [layout, setLayout] = useState<DiffLayout>("auto");
  const [wide, setWide] = useState(false);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{ files: ReviewFile[]; revision: number; error?: string }>();
  const [result, setResult] = useState<{ revision: number; path: string; value: ReviewPatch }>();
  const panel = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const lastRefreshVersion = useRef(refreshVersion);
  const style = layout === "auto" ? (wide ? "split" : "unified") : layout;
  const files = list?.files ?? [];
  const editPath = requestedPath ?? "Edit patch";
  const showEdit = Boolean(selectedPatch && path === editSelection);
  const listReady = list?.revision === revision;
  const selectedFile = typeof path === "string" ? files.find(candidate => candidate.path === path) : undefined;
  const missingRequestedFile = listReady && !list?.error && !selectedFile && requestedGitPath !== undefined && requestedGitPath === path;
  const file = showEdit || missingRequestedFile ? undefined : selectedFile ?? files[0];
  const currentPath = file?.path;
  const currentResult = result?.path === currentPath ? result?.value : undefined;
  const patch = showEdit ? selectedPatch : currentResult?.patch;
  const parsed = usePatch(patch);
  const query = filter.trim().toLocaleLowerCase();
  const visibleFiles = files.filter(candidate => !query || candidate.path.toLocaleLowerCase().includes(query));
  const fileTabStop = visibleFiles.find(candidate => candidate.path === currentPath) ?? visibleFiles[0];

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const resize = () => setWide(element.clientWidth >= splitMinimumWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const last = lastSelection.current;
    if (last.initialPath === initialPath && last.selectedPatch === selectedPatch && last.selectionVersion === selectionVersion) return;
    lastSelection.current = { initialPath, selectedPatch, selectionVersion };
    setPath(initialPath ?? rememberedPath);
    setFilter("");
  }, [initialPath, rememberedPath, selectedPatch, selectionVersion]);

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
    if ((overlay || selectionVersion !== undefined) && !panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, [overlay, selectionVersion]);

  useEffect(() => {
    if (!project.trusted || showEdit) return;
    let active = true;
    void window.pideck.invoke("review:list", { projectId: project.id }).then(
      next => { if (active) setList({ files: next, revision }); },
      cause => { if (active) setList(previous => ({ files: previous?.files ?? [], revision, error: message(cause) })); },
    );
    return () => { active = false; };
  }, [project.id, project.trusted, revision, showEdit]);

  useEffect(() => {
    if (!listReady || !list || list.error) return;
    setPath(current => typeof current === "string" && current !== requestedGitPath
      && !list.files.some(candidate => candidate.path === current) ? undefined : current);
  }, [list, listReady, requestedGitPath]);

  useEffect(() => {
    if (listReady && !list?.error && !showEdit && !missingRequestedFile) onRememberPath?.(currentPath);
  }, [currentPath, list?.error, listReady, missingRequestedFile, onRememberPath, showEdit]);

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

  const loading = !showEdit && (!listReady || Boolean(currentPath && !list?.error
    && (result?.path !== currentPath || result.revision !== revision)));
  const hasDiff = parsed.some(item => item.hunks.length > 0);
  const displayedPath = showEdit ? editPath : currentPath ?? (missingRequestedFile ? requestedGitPath : undefined);
  const showFileList = !showEdit && (files.length > 1 || Boolean(missingRequestedFile && files.length) || Boolean(filter));
  return <aside className="workspace-review" id="review-panel" ref={panel} tabIndex={-1} aria-label="Review changes"
    data-overlay={overlay || undefined} onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement && filter) setFilter("");
    else onClose();
  }}>
    <header className="workspace-panel-header">
      {overlay && <button type="button" className="workspace-icon-button workspace-back" onClick={onClose}
        aria-label="Back to chat" title="Back to chat (Esc)"><ArrowLeft size={17} aria-hidden="true" /></button>}
      <h2>{showEdit ? "Assistant edit" : "Changes"}</h2>
      {!showEdit && files.length > 0 && <span className="workspace-panel-meta">{files.length} {files.length === 1 ? "file" : "files"}</span>}
      <div className="workspace-panel-actions">
        {showEdit ? <button type="button" className="workspace-action" onClick={() => {
          setPath(rememberedPath ?? requestedPath);
          setRevision(value => value + 1);
          panel.current?.focus();
        }}>Project changes</button>
          : <button type="button" className="workspace-icon-button" onClick={() => setRevision(value => value + 1)}
            disabled={!project.trusted || !listReady} aria-label="Refresh changes" title="Refresh changes">
            <RefreshCw size={16} aria-hidden="true" />
          </button>}
      </div>
    </header>
    {!project.trusted ? <p className="workspace-empty">Trust this project to review its changes.</p>
      : !list && !showEdit ? <p className="workspace-empty" role="status">Reading changes…</p>
      : <>
        {!showEdit && list?.error && <p className="workspace-empty" role="alert">{list.error}</p>}
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
              aria-current={selected ? "true" : undefined} onClick={() => setPath(candidate.path)}>
              <Icon name="file" className="workspace-file-icon" />
              <FileLabel path={candidate.path} />
              <FileStatus status={candidate.status} />
            </button>;
          })}
          {query && visibleFiles.length === 0 && <p className="workspace-filter-empty">No matching paths.</p>}
        </nav>}
        {displayedPath ? <>
          <div className="workspace-diff-header">
            <h3 title={showEdit ? `Assistant patch for ${editPath}` : file ? fileDescription(file) : displayedPath}
              aria-description={file ? fileStatus(file.status) : undefined}>
              <Icon name="file" className="workspace-file-icon" />
              <FileLabel path={displayedPath} />
              {file && !showFileList && <FileStatus status={file.status} />}
            </h3>
            <ChangeCount files={parsed} />
            {hasDiff && <div className="workspace-layout">
              <select aria-label="Diff layout" title="Diff layout" value={layout}
                onChange={event => setLayout(event.target.value as DiffLayout)}>
                <option value="auto">Auto layout</option>
                <option value="unified">Unified</option>
                <option value="split">Side by side</option>
              </select>
              <Icon name="down" width={12} height={12} />
            </div>}
          </div>
          {patch ? <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
            <Virtualizer key={`${showEdit ? "assistant" : "git"}-${displayedPath}`} className="workspace-review-scroll">
              <PatchView patch={patch} files={parsed} style={style} wrap />
            </Virtualizer>
          </WorkerPoolContextProvider> : !list?.error && <div className="workspace-review-scroll">
            <p className="workspace-empty" role={loading ? "status" : undefined}>
              {loading ? "Reading diff…" : currentResult?.reason ?? "This file has no current Git changes."}
            </p>
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
