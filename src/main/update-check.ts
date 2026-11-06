const repository = "minifish-org/pideck";
export const releasesPage = `https://github.com/${repository}/releases`;
const api = `https://api.github.com/repos/${repository}/releases`;

export type UpdateCheckResult =
  | { status: "available"; version: string; releaseUrl: string }
  | { status: "current" }
  | { status: "empty" }
  | { status: "error"; reason: "unavailable" | "request" | "response" };

function parseVersion(value: string) {
  if (value.length > 128) return;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[0].length !== value.length) return;
  const [, major, minor, patch, prerelease] = match;
  if (prerelease?.split(".").some(identifier => /^0\d+$/.test(identifier))) return;
  return { core: [BigInt(major), BigInt(minor), BigInt(patch)], prerelease: Boolean(prerelease) };
}

export async function checkForUpdate(installedVersion: string,
  fetchRelease: (url: string, options: RequestInit) => Promise<Response>): Promise<UpdateCheckResult> {
  const installed = parseVersion(installedVersion);
  if (!installed) return { status: "error", reason: "response" };

  const options = {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
  } satisfies RequestInit;

  try {
    const latest = await fetchRelease(`${api}/latest`, options);
    if (latest.status === 404) {
      // GitHub uses 404 for both a missing latest release and a private repository.
      const listing = await fetchRelease(`${api}?per_page=1`, options);
      if (listing.status === 401 || listing.status === 404) return { status: "error", reason: "unavailable" };
      if (!listing.ok) return { status: "error", reason: "request" };
      const releases: unknown = await listing.json().catch(() => undefined);
      if (Array.isArray(releases)) return { status: "empty" };
      return { status: "error", reason: options.signal.aborted ? "request" : "response" };
    }
    if (latest.status === 401) return { status: "error", reason: "unavailable" };
    if (!latest.ok) return { status: "error", reason: "request" };

    const data: unknown = await latest.json().catch(() => undefined);
    if (options.signal.aborted) return { status: "error", reason: "request" };
    if (!data || typeof data !== "object" || !("tag_name" in data) || typeof data.tag_name !== "string"
        || !("draft" in data) || data.draft !== false || !("prerelease" in data) || data.prerelease !== false) {
      return { status: "error", reason: "response" };
    }
    const tag = data.tag_name;
    const release = parseVersion(tag);
    if (!release || release.prerelease) return { status: "error", reason: "response" };

    const difference = release.core.findIndex((part, index) => part !== installed.core[index]);
    const newer = difference < 0 ? installed.prerelease : release.core[difference] > installed.core[difference];
    return newer ? { status: "available", version: tag.replace(/^v/, ""), releaseUrl: `${releasesPage}/tag/${encodeURIComponent(tag)}` }
      : { status: "current" };
  } catch {
    return { status: "error", reason: "request" };
  }
}
