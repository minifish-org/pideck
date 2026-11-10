// Provider diagnostics are untrusted text, and can contain request credentials.
// Keep actionable messages without forwarding headers, tokens, or unbounded stacks.
export function safeFailureDetail(detail: string | undefined): string | undefined {
  if (!detail) return;
  const text = detail
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|secret|password)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk|sess|ghp|gho|github_pat)[-_][a-zA-Z0-9_-]{8,}/g, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        url.username = ''; url.password = '';
        if (url.search) url.search = '?[redacted]';
        url.hash = '';
        return url.toString();
      } catch { return '[url omitted]'; }
    })
    .trim().split('\n').slice(0, 4).join('\n');
  return text ? text.slice(0, 1200) : undefined;
}
