import type { FileDiffMetadata } from "@pierre/diffs";

export function diffContainsLine(files: FileDiffMetadata[], line: number) {
  return files.some(file => file.hunks.some(hunk => line >= hunk.additionStart
    && line < hunk.additionStart + hunk.additionCount));
}

export function fileLineCount(contents: string) {
  if (!contents) return 0;
  const count = contents.split("\n").length;
  return contents.endsWith("\n") ? count - 1 : count;
}
