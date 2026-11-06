import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import type { Project, ReviewFile, ReviewPatch } from "../shared/api";
import "./workspace.css";

type DiffStyle = "unified" | "split";

const diffOptions: FileDiffOptions<undefined, undefined> = {
  theme: "pierre-dark",
  themeType: "dark",
  preferredHighlighter: "shiki-js",
  disableFileHeader: true,
  lineDiffType: "word-alt",
  maxLineDiffLength: 300,
  tokenizeMaxLineLength: 2_000,
};

function PatchView({ patch, style }: { patch: string; style: DiffStyle }) {
  const files = useMemo(() => {
    if (patch.length > 512 * 1024 || patch.split("\n", 8_001).length > 8_000) return [];
    try {
      return parsePatchFiles(patch, { throwOnError: true }).flatMap(parsed => parsed.files);
    } catch {
      return [];
    }
  }, [patch]);

  if (files.length === 0 || files.every(file => file.hunks.length === 0)) {
    return <pre className="workspace-raw-patch">{patch}</pre>;
  }
  return files.map((file, index) => (
    <FileDiff key={`${file.name}-${index}`} fileDiff={file} className="workspace-diff" options={{
      ...diffOptions,
      diffStyle: style,
      disableFileHeader: files.length === 1,
    }} />
  ));
}

export function InlineDiff({ patch, onOpen }: { patch: string; onOpen?: () => void }) {
  const lineCount = patch.split("\n").length;
  const isSmall = lineCount <= 45 && patch.length <= 16_384;
  if (!isSmall && onOpen) {
    return <div className="workspace-inline workspace-inline-large">
      <span>{lineCount.toLocaleString()} lines in patch</span>
      <button type="button" className="workspace-action" onClick={onOpen}>Open review <span aria-hidden="true">↗</span></button>
    </div>;
  }
  return <details className="workspace-inline" open={isSmall}>
    <summary>Changes <span>{lineCount} lines in patch</span></summary>
    <div className="workspace-inline-scroll"><PatchView patch={patch} style="unified" /></div>
    {onOpen && <button type="button" className="workspace-inline-open" onClick={onOpen}>Open review <span aria-hidden="true">↗</span></button>}
  </details>;
}

type ReviewPanelProps = { project: Project; onClose: () => void; selectedPath?: string; selectedPatch?: string };
const editSelection = Symbol("chat edit");

export function ReviewPanel(props: ReviewPanelProps) {
  return <ProjectReview key={props.project.id} {...props} />;
}

function ProjectReview({ project, onClose, selectedPath, selectedPatch }: ReviewPanelProps) {
  const [path, setPath] = useState<string | symbol | undefined>(selectedPatch ? editSelection : selectedPath);
  const [style, setStyle] = useState<DiffStyle>("unified");
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{ files: ReviewFile[]; revision: number; error?: string }>();
  const [result, setResult] = useState<{ revision: number; path: string; value: ReviewPatch }>();
  const files = list?.files ?? [];
  const editPath = selectedPath ?? "Edit patch";
  const showEdit = Boolean(selectedPatch && (path === editSelection || files.length === 0));
  const file = showEdit ? undefined : files.find(candidate => candidate.path === path) ?? files[0];
  const currentPath = file?.path;
  const listReady = list?.revision === revision;
  const currentResult = result?.revision === revision && result.path === currentPath ? result.value : undefined;

  useEffect(() => setPath(selectedPatch ? editSelection : selectedPath), [selectedPath, selectedPatch]);

  useEffect(() => {
    if (!project.trusted) return;
    let active = true;
    void window.pideck.invoke("review:list", { projectId: project.id }).then(
      next => { if (active) setList({ files: next, revision }); },
      cause => { if (active) setList({ files: [], revision, error: message(cause) }); },
    );
    return () => { active = false; };
  }, [project.id, project.trusted, revision]);

  useEffect(() => {
    if (!project.trusted || !listReady || !currentPath) return;
    let active = true;
    void window.pideck.invoke("review:patch", { projectId: project.id, path: currentPath }).then(
      value => { if (active) setResult({ revision, path: currentPath, value }); },
      cause => { if (active) setResult({ revision, path: currentPath, value: { patch: null, reason: message(cause) } }); },
    );
    return () => { active = false; };
  }, [project.id, project.trusted, currentPath, listReady, revision]);

  return <aside className="workspace-review" aria-label="Review changes">
    <header className="workspace-panel-header">
      <h2>Changes</h2>
      <span className="workspace-count">{files.length + Number(Boolean(selectedPatch))}</span>
      <button type="button" className="workspace-icon-button workspace-refresh" onClick={() => setRevision(value => value + 1)}
        disabled={!project.trusted || !listReady} aria-label="Refresh changes" title="Refresh changes">↻</button>
      <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close review" title="Close review">×</button>
    </header>
    {!project.trusted ? <p className="workspace-empty">Trust this project to review its changes.</p>
      : !listReady && !selectedPatch ? <p className="workspace-empty" role="status">Reading changes…</p>
      : !file && !showEdit ? <p className="workspace-empty" role={list?.error ? "alert" : undefined}>
        {list?.error ?? "No Git changes in this project."}
      </p>
      : <>
        <nav className="workspace-file-list" aria-label="Changed files">
          {selectedPatch && <button type="button" title={`Edit patch for ${editPath}`}
            aria-current={showEdit ? "true" : undefined} onClick={() => setPath(editSelection)}>
            <span className="workspace-file-status" data-status="E">Edit</span>
            <span>{editPath}</span>
          </button>}
          {files.map(candidate => <button key={candidate.path} type="button"
            title={candidate.oldPath ? `${candidate.oldPath} → ${candidate.path}` : candidate.path}
            aria-current={candidate.path === currentPath ? "true" : undefined} onClick={() => setPath(candidate.path)}>
            <span className="workspace-file-status" data-status={candidate.status.trim().slice(0, 1)}>{candidate.status.trim()}</span>
            <span>{candidate.path}</span>
          </button>)}
        </nav>
        <div className="workspace-diff-toolbar">
          <span title={file?.path ?? editPath}>{file?.path ?? editPath}</span>
          <div className="workspace-segmented" role="group" aria-label="Diff layout">
            <button type="button" aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>Unified</button>
            <button type="button" aria-pressed={style === "split"} onClick={() => setStyle("split")}>Split</button>
          </div>
        </div>
        <div className="workspace-review-scroll">
          {showEdit && selectedPatch ? <PatchView patch={selectedPatch} style={style} />
            : !currentResult ? <p className="workspace-empty" role="status">Reading diff…</p>
            : currentResult.patch ? <PatchView patch={currentResult.patch} style={style} />
            : <p className="workspace-empty">{currentResult.reason ?? "No text changes."}</p>}
        </div>
      </>}
  </aside>;
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unable to load the project's changes.";
}
