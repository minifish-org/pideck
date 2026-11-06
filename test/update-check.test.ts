import assert from "node:assert/strict";
import { test } from "node:test";
import { checkForUpdate, releasesPage } from "../src/main/update-check";

const releasesApi = "https://api.github.com/repos/minifish-org/pideck/releases";

function release(tag: string, details: Record<string, unknown> = {}) {
  return Response.json({ tag_name: tag, draft: false, prerelease: false, ...details });
}

test("update check uses anonymous HTTPS and offers a newer stable release at its official tag URL", async () => {
  const result = await checkForUpdate("1.2.9", async (url, options) => {
    assert.equal(url, `${releasesApi}/latest`);
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return release("v1.2.10+build.7", { html_url: "https://untrusted.example/update" });
  });
  assert.deepEqual(result, {
    status: "available",
    version: "1.2.10+build.7",
    releaseUrl: `${releasesPage}/tag/v1.2.10%2Bbuild.7`,
  });
});

test("update check orders versions numerically and stable takes precedence over the same prerelease", async () => {
  for (const version of ["1.2.3", "1.2.3+local", "1.10.0", "2.0.0-rc.1"]) {
    assert.deepEqual(await checkForUpdate(version, async () => release("v1.2.3")), { status: "current" });
  }
  assert.deepEqual(await checkForUpdate("1.2.3-rc.1", async () => release("1.2.3")), {
    status: "available", version: "1.2.3", releaseUrl: `${releasesPage}/tag/1.2.3`,
  });
});

test("a missing latest release distinguishes an empty public channel from an inaccessible repository", async () => {
  for (const publicListing of [true, false]) {
    const requested: string[] = [];
    let firstSignal: AbortSignal | null | undefined;
    const result = await checkForUpdate("1.2.3", async (url, options) => {
      requested.push(String(url));
      if (requested.length === 1) {
        firstSignal = options?.signal;
        return new Response(null, { status: 404 });
      }
      assert.equal(options?.signal, firstSignal);
      return publicListing ? Response.json([]) : new Response(null, { status: 404 });
    });
    assert.deepEqual(requested, [`${releasesApi}/latest`, `${releasesApi}?per_page=1`]);
    assert.deepEqual(result, publicListing ? { status: "empty" } : { status: "error", reason: "unavailable" });
  }
});

test("update check reports transport, HTTP, and malformed responses separately from a current build", async () => {
  assert.deepEqual(await checkForUpdate("1.2.3", async () => { throw new DOMException("Deadline elapsed", "TimeoutError"); }),
    { status: "error", reason: "request" });
  assert.deepEqual(await checkForUpdate("1.2.3", async () => new Response(null, { status: 429 })),
    { status: "error", reason: "request" });
  assert.deepEqual(await checkForUpdate("1.2.3", async () => new Response("invalid JSON")),
    { status: "error", reason: "response" });
  for (const invalid of [release("../unsafe"), release("1.2.4\n"), release("v1.2.4", { draft: true }),
    release("v1.2.4-rc.1"), release("v1.2.4", { prerelease: true })]) {
    assert.deepEqual(await checkForUpdate("1.2.3", async () => invalid), { status: "error", reason: "response" });
  }
});
