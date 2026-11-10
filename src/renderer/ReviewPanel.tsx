import { parsePatchFiles, type CodeViewLineSelection, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView, FileDiff, Virtualizer, WorkerPoolContextProvider, type CodeViewHandle, type FileDiffOptions } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project, ReviewFile, ReviewFileContents, ReviewPatch } from "../shared/api";
import { Icon } from "./Icons";
import { useAppearance } from "./appearance";
import { diffContainsLine, fileLineCount } from "./review-target";
import "./workspace.css";

type DiffStyle = "unified" | "split";
type DiffLayout = "auto" | DiffStyle;
const splitMinimumWidth = 700;
const workerOptions = { workerFactory: () => new DiffWorker(), poolSize: 1, mainThreadMaxCharacters: 12_000 };
const highlighterOptions = {
  theme: { dark: "github-dark-default", light: "github-light-default" },
  preferredHighlighter: "shiki-js", lineDiffType: "word-alt", tokenizeMaxLineLength: 2_000,
} as const;
const diffOptions = {
  ...highlighterOptions,
  // Primer Light already supplies complete line and gutter backgrounds.
  // Keep Pierre's dark blend, but use the light backgrounds directly.
  unsafeCSS: '[data-line-type="change-addition"], [data-line-type="change-deletion"] { --mix-light: 0%; }',
  enableLineSelection: true,
  hunkSeparators: "line-info",
  maxLineDiffLength: 300,
} satisfies FileDiffOptions<undefined, undefined>;
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
  const appearance = useAppearance();
  if (files.length === 0 || files.every(file => file.hunks.length === 0)) {
    return <pre className="workspace-raw-patch">{patch}</pre>;
  }
  return files.map((file, index) => <FileDiff key={file.cacheKey ?? index} fileDiff={file} className="workspace-diff" options={{
    ...diffOptions,
    themeType: appearance,
    diffStyle: style,
    overflow: wrap ? "wrap" : "scroll",
    disableFileHeader: files.length === 1,
  }} />);
}

function LinkedPatchView({ files, style, line, selectionVersion }: {
  files: FileDiffMetadata[]; style: DiffStyle; line: number; selectionVersion?: number;
}) {
  const appearance = useAppearance();
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const items = useMemo(() => files.map((fileDiff, index) => ({
    id: fileDiff.cacheKey ?? String(index), type: "diff" as const, fileDiff,
  })), [files]);
  const id = items.findLast(item => diffContainsLine([item.fileDiff], line))?.id;
  useEffect(() => {
    if (!id) return;
    viewer.current?.setSelectedLines({ id, range: { start: line, end: line, side: "additions" } });
    viewer.current?.scrollTo({ type: "line", id, lineNumber: line, side: "additions", align: "center" });
  }, [id, line, selectionVersion]);
  return <CodeView ref={viewer} className="workspace-review-scroll workspace-diff" items={items}
    options={{ ...diffOptions, hunkSeparators: "line-info", themeType: appearance, diffStyle: style,
      overflow: "wrap", disableFileHeader: files.length === 1 }} />;
}

type PreviewPosition = { top: number; line?: number; offset?: number };

function FilePreview({ projectId, path, line, selectionVersion, revision, visible, initialPosition, onScrollPosition }: {
  projectId: string; path: string; line?: number; selectionVersion?: number; revision: number; visible: boolean; initialPosition?: PreviewPosition;
  onScrollPosition: (position: PreviewPosition) => void;
}) {
  const [result, setResult] = useState<{ value?: ReviewFileContents; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState(true);
  useEffect(() => {
    if (!visible) return;
    const scope = { projectId, path, requestId: crypto.randomUUID() };
    let active = true;
    setReading(true);
    void window.pideck.invoke("review:file", scope).then(
      value => { if (active) { setResult({ value }); setReading(false); } },
      cause => { if (active) { setResult({ error: message(cause) }); setReading(false); } },
    );
    return () => {
      active = false;
      void window.pideck.invoke("review:file-cancel", { projectId, requestId: scope.requestId }).catch(() => {});
    };
  }, [projectId, path, revision, visible, attempt]);
  if (!result) return <p className="workspace-empty" role="status">Reading file…</p>;
  if (result.error) return <ReviewIssue message={result.error} onRetry={() => setAttempt(current => current + 1)} />;
  const contents = result.value?.contents;
  if (contents === null || contents === undefined) return <p className="workspace-empty" role="status">{result.value?.reason}</p>;
  return <PreviewContents path={path} contents={contents} line={line} reading={reading}
    selectionVersion={selectionVersion} initialPosition={initialPosition} visible={visible} onScrollPosition={onScrollPosition} />;
}

function PreviewContents({ path, contents, line, selectionVersion, reading, initialPosition, visible, onScrollPosition }: {
  path: string; contents: string; line?: number; selectionVersion?: number; reading: boolean; initialPosition?: PreviewPosition;
  visible: boolean; onScrollPosition: (position: PreviewPosition) => void;
}) {
  const appearance = useAppearance();
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const shown = useRef(visible);
  const readingPosition = useRef(line === undefined ? initialPosition : undefined);
  const restoring = useRef(false);
  const restoreFrame = useRef<number | undefined>(undefined);
  const scrollAppearance = useRef(appearance);
  const rememberPosition = useCallback((top: number) => {
    const instance = viewer.current?.getInstance();
    const item = instance?.getRenderedItems().find(item => item.id === path && item.type === "file");
    const itemTop = instance?.getTopForItem(path);
    const anchor = item?.type === "file" && itemTop !== undefined ? item.instance.getNumericScrollAnchor(top - itemTop) : undefined;
    const position = { top, ...(anchor && itemTop !== undefined ? { line: anchor.lineNumber, offset: itemTop + anchor.top - top } : {}) };
    readingPosition.current = position;
    onScrollPosition(position);
  }, [onScrollPosition, path]);
  const restorePosition = useCallback(() => {
    if (!shown.current || !restoring.current || restoreFrame.current !== undefined
      || readingPosition.current === undefined || !container.current?.clientHeight) return;
    restoreFrame.current = requestAnimationFrame(() => {
      restoreFrame.current = undefined;
      if (!container.current?.clientHeight || readingPosition.current === undefined) return;
      const instance = viewer.current?.getInstance();
      if (!instance) return;
      const target = readingPosition.current;
      const item = instance.getRenderedItems().find(item => item.id === path && item.type === "file");
      const itemTop = instance.getTopForItem(path);
      const position = target.line !== undefined && item?.type === "file" ? item.instance.getLinePosition(target.line) : undefined;
      const desiredTop = position && itemTop !== undefined ? itemTop + position.top - (target.offset ?? 0) : target.top;
      const boundedTop = Math.max(0, Math.min(desiredTop, instance.getScrollHeight() - instance.getHeight()));
      if (Math.abs(instance.getScrollTop() - boundedTop) <= 1) return;
      if (target.line !== undefined) {
        viewer.current?.scrollTo({ type: "line", id: path, lineNumber: target.line, align: "start", offset: target.offset, behavior: "instant" });
      } else viewer.current?.scrollTo({ type: "position", position: target.top, behavior: "instant" });
    });
  }, [path]);
  const resumeReading = useCallback(() => {
    restoring.current = false;
    if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = undefined;
    const top = viewer.current?.getInstance()?.getScrollTop();
    if (top !== undefined) rememberPosition(top);
  }, [rememberPosition]);
  useLayoutEffect(() => {
    shown.current = visible;
    restoring.current = true;
    scrollAppearance.current = appearance;
    if (visible && readingPosition.current !== undefined) restorePosition();
    else if (visible) restoring.current = false;
    return () => {
      if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = undefined;
    };
  }, [appearance, restorePosition, visible]);
  useEffect(() => {
    const element = container.current;
    if (!visible || !element) return;
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) resumeReading();
    };
    element.addEventListener("wheel", resumeReading, { passive: true });
    element.addEventListener("pointerdown", resumeReading);
    element.addEventListener("keydown", onKey);
    return () => {
      element.removeEventListener("wheel", resumeReading);
      element.removeEventListener("pointerdown", resumeReading);
      element.removeEventListener("keydown", onKey);
    };
  }, [resumeReading, visible]);
  const onRendered = useCallback(() => {
    if (restoring.current) restorePosition();
    else if (shown.current) {
      if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = requestAnimationFrame(() => {
        restoreFrame.current = undefined;
        if (!shown.current || restoring.current) return;
        const top = viewer.current?.getInstance()?.getScrollTop();
        if (top !== undefined) rememberPosition(top);
      });
    }
  }, [rememberPosition, restorePosition]);
  const items = useMemo(() => [{ id: path, type: "file" as const,
    file: { name: path, contents, cacheKey: `pideck-file-${++patchId}` } }], [path, contents]);
  const lineCount = fileLineCount(contents);
  const lineExists = line !== undefined && line <= lineCount;
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(() => lineExists && line !== undefined
    ? { id: path, range: { start: line, end: line } } : null);
  const lastLocation = useRef<{ line?: number; selectionVersion?: number; lineExists: boolean; hidden?: boolean;
    instance: ReturnType<CodeViewHandle<undefined, undefined>["getInstance"]> } | undefined>(undefined);
  useEffect(() => {
    if (!visible) {
      if (lastLocation.current) lastLocation.current.hidden = true;
      return;
    }
    if (reading) return;
    const instance = viewer.current?.getInstance();
    if (!instance) return;
    const previous = lastLocation.current;
    const sameLocation = previous && previous.line === line && previous.selectionVersion === selectionVersion;
    if (previous?.instance === instance && previous.line === line
      && previous.selectionVersion === selectionVersion && previous.lineExists === lineExists) return;
    lastLocation.current = { line, selectionVersion, lineExists, instance };
    if (!lineExists || line === undefined) {
      if (!sameLocation) setSelectedLines(null);
      return;
    }
    if (!sameLocation) setSelectedLines({ id: path, range: { start: line, end: line } });
    if (!sameLocation || !previous.hidden) {
      resumeReading();
      viewer.current?.scrollTo({ type: "line", id: path, lineNumber: line, align: "center", behavior: "instant" });
    }
  }, [items, line, lineExists, path, reading, resumeReading, selectionVersion, visible]);
  return <>
    {!reading && line !== undefined && !lineExists && <p className="workspace-empty" role="status">Line {line} is not in this file.</p>}
    {!contents ? <p className="workspace-empty">Empty file.</p>
      : visible && <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
          <CodeView ref={viewer} className="workspace-review-scroll workspace-diff" items={items}
            selectedLines={selectedLines} onSelectedLinesChange={setSelectedLines}
            containerRef={element => {
              container.current = element;
              if (element) {
                element.dataset.filePreview = path;
                element.setAttribute("aria-busy", String(reading));
              }
            }}
            onScroll={position => {
              if (visible && !restoring.current && scrollAppearance.current === appearance) rememberPosition(position);
            }}
            options={{ ...highlighterOptions, enableLineSelection: true, themeType: appearance, overflow: "wrap", disableFileHeader: true,
              onPostRender: onRendered }} />
        </WorkerPoolContextProvider>}
  </>;
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

function ReadOnlyFile() {
  return <span className="workspace-panel-meta" role="img" title="Read-only project file" aria-label="Read-only project file"><Icon name="lock" /></span>;
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
  selectedLine?: number;
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

function ProjectReview({ project, visible, overlay, onClose, selectedPath, selectedPatch, selectedLine, onSelectWorkingTreeFile,
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
  const [previewSelection, setPreviewSelection] = useState<{ path: string; selectionVersion?: number }>();
  const panel = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const watchReady = useRef(false);
  const scrollPositions = useRef(new Map<string, number>());
  const previewPositions = useRef(new Map<string, PreviewPosition>());
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
  const loading = !listReady || Boolean(currentPath && !list?.error
    && (result?.path !== currentPath || result.revision !== revision));
  const previewPath = requestedGitPath && requestedGitPath === path
    && ((previewSelection?.path === requestedGitPath && previewSelection.selectionVersion === selectionVersion)
      || list?.error || missingRequestedFile || (selectedLine !== undefined && currentResult
      && !diffContainsLine(parsed, selectedLine))) ? requestedGitPath : undefined;
  const query = filter.trim().toLocaleLowerCase();
  const visibleFiles = files.filter(candidate => !query || candidate.path.toLocaleLowerCase().includes(query));
  const fileTabStop = visibleFiles.find(candidate => candidate.path === currentPath) ?? visibleFiles[0];
  const displayedPath = previewPath ?? (showMessagePatch ? messagePath : currentPath ?? (missingRequestedFile ? requestedGitPath : undefined));
  const diffKey = showMessagePatch ? `chat-${selectionVersion}-${displayedPath}` : `git-${displayedPath}`;
  const scrollKey = previewPath ? `file-${previewPath}` : diffKey;
  const refresh = useCallback(() => setRefreshRequested(true), []);
  const rememberPreviewScroll = useCallback((position: PreviewPosition) => previewPositions.current.set(scrollKey, position), [scrollKey]);

  useEffect(() => {
    if (previewPath) setPreviewSelection(current => current?.path === previewPath && current.selectionVersion === selectionVersion
      ? current : { path: previewPath, selectionVersion });
  }, [previewPath, selectionVersion]);

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
    const saved = scrollPositions.current.get(scrollKey);
    if (saved === undefined) return;
    if (!visible || previewPath) return;
    const scroller = panel.current?.querySelector<HTMLElement>(".workspace-review-scroll");
    if (scroller) scroller.scrollTop = saved;
  }, [previewPath, scrollKey, visible]);

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
    if (!visible) return;
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
      if (event.type === "host:restart" || event.type === "host:resume") setWatchAttempt(attempt => attempt + 1);
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
  }, [project.id, refresh, visible, watchAttempt]);

  useEffect(() => {
    if (visible && (overlay || selectionVersion !== undefined) && !panel.current?.contains(document.activeElement)) {
      panel.current?.focus({ preventScroll: true });
    }
  }, [overlay, selectionVersion, visible]);

  useEffect(() => {
    if (!visible || !watchReady.current) return;
    let active = true;
    void window.pideck.invoke("review:list", { projectId: project.id }).then(
      next => { if (active) setList({ files: next, revision }); },
      cause => { if (active) setList(previous => ({ files: previous?.files ?? [], revision, error: message(cause) })); },
    );
    return () => { active = false; };
  }, [project.id, revision, visible]);

  useEffect(() => {
    if (!listReady || !list || list.error) return;
    setPath(current => current !== undefined && current !== requestedGitPath
      && !list.files.some(candidate => candidate.path === current) ? undefined : current);
  }, [list, listReady, requestedGitPath]);

  useEffect(() => {
    if (listReady && !list?.error && !showMessagePatch && !missingRequestedFile) onRememberPath?.(currentPath);
  }, [currentPath, list?.error, listReady, missingRequestedFile, onRememberPath, showMessagePatch]);

  useEffect(() => {
    if (!visible || !watchReady.current || !listReady || !currentPath || list?.error) return;
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
  }, [project.id, currentPath, listReady, list?.error, revision, visible]);

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
  const layoutControl = !previewPath && parsed.some(item => item.hunks.length > 0) && <div className="workspace-layout">
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
      if (visible && !previewPath && event.target instanceof HTMLElement && event.target.classList.contains("workspace-review-scroll")) {
        scrollPositions.current.set(scrollKey, event.target.scrollTop);
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
      {showSelectionInList && (previewPath ? <ReadOnlyFile /> : <><ChangeCount files={parsed} />{layoutControl}</>)}
    </header>
    {!list && !showMessagePatch ? <p className="workspace-empty" role="status">Reading changes…</p>
      : <>
        {!previewPath && (list?.error || (watchError && !currentResult?.error)) && <ReviewIssue
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
                }
                setPreviewSelection(undefined);
                onSelectWorkingTreeFile(candidate.path);
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
            {previewPath ? <ReadOnlyFile />
              : <ChangeCount files={parsed} />}
            {layoutControl}
          </div>}
          {previewPath ? <FilePreview key={previewPath} projectId={project.id} path={previewPath} line={selectedLine}
            selectionVersion={selectionVersion} revision={revision} visible={visible}
            initialPosition={previewPositions.current.get(scrollKey)} onScrollPosition={rememberPreviewScroll} />
            : patch ? <WorkerPoolContextProvider poolOptions={workerOptions} highlighterOptions={highlighterOptions}>
            {selectedLine && currentPath === requestedGitPath && parsed.length > 0
              ? <LinkedPatchView key={diffKey} files={parsed} style={style} line={selectedLine} selectionVersion={selectionVersion} />
              : <Virtualizer key={diffKey} className="workspace-review-scroll">
              <PatchView patch={patch} files={parsed} style={style} wrap />
            </Virtualizer>}
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
