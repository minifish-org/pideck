import { sessionTitle } from "../shared/session-title.js";

// A plain-text excerpt, not a second model-generated summary. Keep formatting
// work in the host, and send only the bounded preview to the main process.
export function notificationPreview(text: string): string | undefined {
  const lines: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    lines.push(line);
  }
  const plain = lines.join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^\s{0,3}\[[^\]\n]+\]:\s+.*$/gm, "")
    .replace(/!\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])/g, "")
    .replace(/\[([^\]\n]+)\](?:\([^\n]*?\)|\[[^\]\n]*\])/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|(?:[-+*]|\d+[.)])\s+)/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*([^*\n]+)\*/g, "$1");
  return sessionTitle(plain, 160) || undefined;
}
