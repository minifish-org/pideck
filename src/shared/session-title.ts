export const sessionTitleLimit = 120;
export const untitledSession = "Untitled session";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeSessionTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortenTitle(title: string, limit: number): string {
  if (title.length <= limit) return title;
  let shortened = "";
  for (const { segment } of graphemes.segment(title)) {
    if (shortened.length + segment.length >= limit) break;
    shortened += segment;
  }
  return shortened.trimEnd() + "…";
}

export function sessionTitle(title: string): string {
  return shortenTitle(normalizeSessionTitle(title), sessionTitleLimit);
}

export function firstSessionTitle(text: string): string {
  const lines = text.split(/[\r\n\u2028\u2029]/u);
  for (const line of lines) {
    const title = normalizeSessionTitle(line).replace(/^#{1,6}\s+/u, "");
    if (title && !/^(\x60{3}|~~~)/u.test(title)) return shortenTitle(title, 80);
  }
  return text.trim() ? "Code request" : "Image request";
}

export function branchTitle(title: string): string {
  const suffix = " (fork)";
  return shortenTitle(normalizeSessionTitle(title) || untitledSession, sessionTitleLimit - suffix.length) + suffix;
}
