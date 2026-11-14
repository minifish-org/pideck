export type ProjectLink = { path: string; line?: number };

const control = /[\u0000-\u001f\u007f]/;
const scheme = /^[a-z][a-z\d+.-]*:/i;
const drive = /^[a-z]:\//i;

// Browser navigation is explicit, never a trusted-host fetch. Local dev servers
// are useful coding links; only the two browser protocols are admitted.
export function externalMessageUrl(raw: string): URL | undefined {
  if (!raw || raw.length > 16_384 || raw !== raw.trim() || control.test(raw)
    || raw.includes("\\") || !/^https?:\/\//i.test(raw)) return;
  try {
    if (control.test(decodeURI(raw)) || /^https?:\/\/[^/?#]*@/i.test(raw)) return;
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return;
    return url;
  } catch { return; }
}

// Images never cause network requests or file:// navigation. The host still
// checks the real path and the conversation that owns a saved tool image.
export function localMessageImagePath(raw: string): string | undefined {
  if (!raw || raw.length > 16_384 || raw !== raw.trim() || control.test(raw)) return;
  let path: string;
  try { path = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); } catch { return; }
  path = path.replaceAll("\\", "/");
  if (!path || control.test(path) || path.startsWith("//") || (scheme.test(path) && !drive.test(path))) return;
  return path;
}

function normalizePath(value: string): string | undefined {
  const path = value.replaceAll("\\", "/");
  const absolute = path.startsWith("/") || drive.test(path);
  if (!absolute) return;
  const prefix = drive.test(path) ? path.slice(0, 2) : "";
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}/${parts.join("/")}`;
}

// Pure lexical classification gives the renderer a useful affordance. The host
// independently resolves the original href and checks the real filesystem path.
export function projectMessageLink(raw: string, directory: string): ProjectLink | undefined {
  if (!raw || raw.length > 16_384 || raw !== raw.trim() || control.test(raw) || raw.startsWith("//")) return;
  const [location, fragment] = raw.split("#", 2);
  let path: string;
  try { path = decodeURIComponent(location!.split("?", 1)[0]!); }
  catch { return; }
  if (!path || control.test(path) || path.startsWith("//") || path.startsWith("\\\\")) return;

  let line: number | undefined;
  const anchor = /^(?:L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|line-(\d+))$/i.exec(fragment ?? "");
  const suffix = /:(\d+)(?::\d+)?$/.exec(path);
  if (anchor) line = Number(anchor[1] ?? anchor[2]);
  if (suffix) {
    if (!anchor) line = Number(suffix[1]);
    path = path.slice(0, suffix.index);
  }
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return;

  const formatted = path.replaceAll("\\", "/");
  if (scheme.test(formatted) && !drive.test(formatted)) return;
  const base = normalizePath(directory);
  const full = normalizePath(formatted.startsWith("/") || drive.test(formatted) ? formatted : `${directory}/${formatted}`);
  if (!base || !full) return;
  const compare = (value: string) => drive.test(base) ? value.toLowerCase() : value;
  const prefix = base.endsWith("/") ? base : base + "/";
  if (!compare(full).startsWith(compare(prefix))) return;
  const relative = full.slice(prefix.length);
  if (!relative) return;
  return { path: relative, ...(line !== undefined ? { line } : {}) };
}
