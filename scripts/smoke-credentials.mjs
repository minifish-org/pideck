/**
 * Opt-in macOS acceptance check against the REAL release/Pideck.app identity.
 *
 *   node scripts/smoke-credentials.mjs --allow-system-keychain
 *
 * This can display a real macOS credential-store permission prompt. A human
 * must handle that prompt; this script never enters passwords, edits ACLs,
 * signs/copies the app, or removes an OS credential-store item. Only a known
 * dummy OpenAI API key is saved, in a private disposable application profile.
 *
 * Commands: seed, next, unlock, observe:none, observe:prompt, status, close,
 * cleanup, capture:/absolute/Desktop/pideck-credentials-name.png. After seed,
 * repeat next -> unlock -> observe:none at least 3 times.
 * `unlock` stays pending while macOS waits; elapsed time never implies PASS.
 * `close` preserves the profile. `cleanup` closes the owned process and removes
 * only this invocation's temporary files, retaining the shared OS key item.
 *
 * The safeStorage observers forward to the original async methods unchanged.
 * They only count calls and compare the decrypted dummy record in memory.
 * Every cold read still goes through the real preload, host and CredentialVault
 * via model:list({ useSaved: true }); the script never decrypts a second copy.
 * No chat, OAuth, catalog-refresh or external-model request is performed. This
 * is not a general network audit or an assertion about other running apps.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  "allow-system-keychain": { type: "boolean", default: false },
  app: { type: "string" },
  restarts: { type: "string", default: "3" },
  help: { type: "boolean", short: "h", default: false },
} });
if (values.help || !values["allow-system-keychain"]) {
  console.log("Usage: node scripts/smoke-credentials.mjs --allow-system-keychain [--app release/mac-arm64/Pideck.app] [--restarts 3]");
  console.log("Opt-in only: uses the real Pideck OS credential-store identity and may require a manual system permission. No app launches without the flag.");
  process.exit(values.help ? 0 : 1);
}
assert.ok(process.platform === "darwin", "This opt-in check currently supports macOS only.");
const requiredReads = Number(values.restarts);
assert.ok(Number.isSafeInteger(requiredReads) && requiredReads >= 3 && requiredReads <= 10,
  "--restarts must be an integer from 3 to 10.");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = await realpath(join(repository, "release"));
const bundle = await realpath(resolve(values.app ?? join(release, `mac-${process.arch}`, "Pideck.app")));
assert.ok(bundle.startsWith(release + sep) && basename(bundle) === "Pideck.app",
  "Use the original release/Pideck.app; renamed or external QA copies are refused.");
const plist = join(bundle, "Contents", "Info.plist");
const plistValue = name => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${name}`, plist], { encoding: "utf8" }).trim();
assert.ok(plistValue("CFBundleIdentifier") === "works.pideck.desktop", "Unexpected application bundle ID.");
assert.ok(plistValue("CFBundleName") === "Pideck", "Unexpected application bundle name.");
assert.ok(plistValue("CFBundleExecutable") === "Pideck", "Unexpected application executable.");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "pipe" });
const executable = join(bundle, "Contents", "MacOS", "Pideck");
const asar = join(bundle, "Contents", "Resources", "app.asar");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const asarHash = digest(await readFile(asar));

// Refuse to mingle this review with an already running copy of this executable.
const existing = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
  .split("\n").filter(line => line.trim().replace(/^\d+\s+/, "").startsWith(executable));
assert.ok(existing.length === 0, "This release app is already running. Close it before the opt-in review.");

const root = await mkdtemp(join(tmpdir(), "pideck-credentials-"));
await chmod(root, 0o700);
const owner = randomUUID();
await writeFile(join(root, "owner"), owner, { mode: 0o600 });
const profile = join(root, "profile");
await mkdir(profile, { mode: 0o700 });
const credentialPath = join(profile, "provider-credentials");
const fixture = "pideck-credentials-smoke-not-a-real-openai-key";
const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: process.env.LANG || "en_US.UTF-8",
  // Avoid even probing a real ambient Google credential file while cataloging.
  GOOGLE_APPLICATION_CREDENTIALS: join(root, "absent-google-credentials"), XDG_CONFIG_HOME: join(root, "config") };
for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING"])
  if (process.env[name]) environment[name] = process.env[name];
const { _electron } = await import("playwright");
let running;
let page;
let phase = "starting";
let active;
let activeName;
let baseline;
let current;
let cleaned = false;
let failed = false;
const rounds = [];
const processIds = new Set();
const accepted = () => !failed && rounds.length >= requiredReads
  && rounds.every(round => round.cryptoPassed && round.observation === "no-system-prompt-observed");
const report = () => ({ phase, active: activeName ?? null, profile, bundle, asarHash,
  requiredColdReads: requiredReads, rounds, current, failed, cleaned, passed: accepted(),
  scope: "real async safeStorage; real app CredentialVault; dummy key; no external model requests; OS item retained" });
async function record() {
  if (!cleaned) await writeFile(join(root, "report.json"), JSON.stringify(report(), null, 2) + "\n", { mode: 0o600 });
}
function say(message) { console.log(message); }
async function fingerprint() {
  const [bytes, info] = await Promise.all([readFile(credentialPath), stat(credentialPath)]);
  assert.ok(bytes.length > 0 && !bytes.includes(Buffer.from(fixture)), "The dummy record must be encrypted on disk.");
  assert.ok((info.mode & 0o077) === 0, "The temporary credential file is readable beyond its owner.");
  return { hash: digest(bytes), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
async function observers() {
  return running.evaluate(() => ({ ...globalThis.__pideckCredentialSmoke }));
}
async function launch() {
  assert.ok(digest(await readFile(asar)) === asarHash, "The release artifact changed during this review.");
  const app = await _electron.launch({ executablePath: executable,
    args: [`--user-data-dir=${profile}`], env: environment, timeout: 30_000 });
  running = app;
  const pid = app.process().pid;
  assert.ok(!processIds.has(pid), "A cold read reused a previous application process.");
  processIds.add(pid);
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.pideck));
  const identity = await app.evaluate(({ app }) => ({
    name: app.getName(), profile: app.getPath("userData"), executable: process.execPath, appPath: app.getAppPath(),
  }));
  say(`LAUNCH IDENTITY ${JSON.stringify(identity)}`);
  assert.ok(identity.name === "pideck" && await realpath(identity.profile) === await realpath(profile) && identity.executable === executable
    && identity.appPath === asar, "The launched process is not the expected real Pideck identity/profile.");
  await app.evaluate(({ safeStorage }, expected) => {
    const state = globalThis.__pideckCredentialSmoke = {
      encryptCalls: 0, decryptCalls: 0, encryptFixture: false, decryptFixture: false, shouldReEncrypt: false,
    };
    const matches = text => {
      try {
        const value = JSON.parse(text);
        return Object.keys(value).length === 1 && value.openai?.type === "api_key" && value.openai.key === expected;
      } catch { return false; }
    };
    const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
    const decrypt = safeStorage.decryptStringAsync.bind(safeStorage);
    safeStorage.encryptStringAsync = async text => {
      state.encryptCalls++;
      state.encryptFixture = matches(text);
      return encrypt(text);
    };
    safeStorage.decryptStringAsync = async bytes => {
      state.decryptCalls++;
      const value = await decrypt(bytes);
      state.decryptFixture = matches(value.result);
      state.shouldReEncrypt ||= value.shouldReEncrypt;
      return value;
    };
  }, fixture);
  const passive = await page.evaluate(() => window.pideck.invoke("model:list"));
  const calls = await observers();
  assert.ok(calls.encryptCalls === 0 && calls.decryptCalls === 0, "Passive startup accessed safeStorage.");
  if (baseline) assert.ok(passive.savedConnectionsPending, "Cold startup did not discover the saved credential file.");
  current = { kind: baseline ? "cold-read" : "seed", pid, number: baseline ? rounds.length + 1 : 0,
    passiveReadDidNotUnlock: true, cryptoPassed: false, observation: null };
  phase = baseline ? "awaiting-unlock" : "awaiting-seed";
  await record();
  say(`READY ${current.kind} ${current.number}; PID ${pid}. Type ${baseline ? "unlock" : "seed"}.`);
}
async function closeApp() {
  if (!running) return;
  const app = running;
  const child = app.process();
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, "exit");
  await app.close();
  running = undefined;
  page = undefined;
  const [code, signal] = await exited;
  say(`APP EXIT code=${code}, signal=${signal}`);
  assert.ok(code === 0 && signal === null, "The owned application did not quit cleanly.");
}
async function seed() {
  assert.ok(phase === "awaiting-seed", "Seed is available only once in the fresh profile.");
  phase = "waiting-for-system-save";
  await record();
  say("WAITING for real credential-store save. Handle any system prompt manually; there is no timeout-based pass.");
  await page.evaluate(async ({ key, flowId }) => {
    let answered = false;
    const dispose = window.pideck.onEvent(event => {
      if (event.type !== "auth:prompt" || event.flowId !== flowId) return;
      if (answered || event.prompt.type !== "secret") return;
      answered = true;
      void window.pideck.invoke("model:auth-answer", { flowId, promptId: event.promptId, value: key });
    });
    try {
      await window.pideck.invoke("model:login", { provider: "openai", method: "api_key", flowId });
      if (!answered) throw new Error("The real API-key prompt was not answered.");
    } finally { dispose(); }
  }, { key: fixture, flowId: randomUUID() });
  const calls = await observers();
  assert.ok(calls.encryptCalls === 1 && calls.encryptFixture && calls.decryptCalls === 0,
    "The real auth flow did not encrypt exactly the expected dummy record.");
  baseline = await fingerprint();
  current.cryptoPassed = true;
  current.encryptCalls = calls.encryptCalls;
  phase = "seeded";
  await record();
  say("SEED SAVED through real auth and CredentialVault. Type next for cold read 1; system prompt observation is required after each cold read.");
}
async function unlock() {
  assert.ok(phase === "awaiting-unlock", "Use next to start a fresh cold-read process first.");
  phase = "waiting-for-system-unlock";
  await record();
  say("WAITING for real CredentialVault decryption. A pending system prompt remains pending, never PASS.");
  const before = await fingerprint();
  assert.ok(JSON.stringify(before) === JSON.stringify(baseline), "The saved encrypted fixture changed before unlocking.");
  const catalog = await page.evaluate(() => window.pideck.invoke("model:list", { useSaved: true }));
  const calls = await observers();
  assert.ok(calls.decryptCalls === 1 && calls.decryptFixture, "The cold process did not decrypt the expected dummy record.");
  assert.ok(calls.encryptCalls === 0 && !calls.shouldReEncrypt, "The cold read rewrote or migrated the encrypted fixture.");
  assert.ok(!catalog.savedConnectionsPending && catalog.models.some(model => model.provider === "openai" && model.configured),
    "The real model catalog did not resolve the saved OpenAI credential.");
  assert.ok(!JSON.stringify(catalog).includes(fixture), "The catalog exposed the dummy key.");
  assert.ok(JSON.stringify(await fingerprint()) === JSON.stringify(baseline), "The cold read changed the encrypted fixture.");
  current.cryptoPassed = true;
  current.decryptCalls = calls.decryptCalls;
  current.encryptCalls = calls.encryptCalls;
  current.ciphertextUnchanged = true;
  phase = "awaiting-prompt-observation";
  await record();
  say("CRYPTO READ VERIFIED; prompt observation is still WAITING. After observing the system UI, type observe:none or observe:prompt.");
}
async function observe(prompted) {
  assert.ok(phase === "awaiting-prompt-observation", "There is no completed cold read awaiting observation.");
  current.observation = prompted ? "system-prompt-observed" : "no-system-prompt-observed";
  rounds.push(current);
  current = undefined;
  failed ||= prompted;
  phase = "cold-read-observed";
  await record();
  if (prompted) say("REPEATED PROMPT OBSERVED: this acceptance check cannot PASS. The profile is preserved for investigation.");
  else say(`OBSERVED ${rounds.length}/${requiredReads}: real decryption without a system prompt.`);
  if (rounds.length >= requiredReads) {
    phase = failed ? "failed" : "passed";
    await record();
    say(failed ? "NOT PASSED. Inspect status, then cleanup when ready."
      : `PASS: ${rounds.length} cold processes decrypted the same saved fixture, with zero encryption calls and manually observed zero prompts. Profile retained until cleanup.`);
  } else say("Type next for the next complete quit/relaunch.");
}
async function cleanup() {
  await closeApp();
  assert.ok((await lstat(root)).isDirectory() && await readFile(join(root, "owner"), "utf8") === owner,
    "Refusing to remove a temporary directory whose ownership marker changed.");
  await rm(root, { recursive: true });
  cleaned = true;
  phase = "cleaned";
  process.exitCode = accepted() ? 0 : 1;
  say("CLEANED only this invocation's temporary profile/report. The release app and all OS credential-store items were retained.");
}
async function command(input) {
  if (input === "status") {
    say(JSON.stringify({ ...report(), liveCalls: running ? await observers().catch(() => null) : null }));
    return;
  }
  if (input === "help") { say("seed | next | unlock | observe:none | observe:prompt | status | close | cleanup | capture:/absolute/Desktop/pideck-credentials-name.png"); return; }
  if (input.startsWith("capture:")) {
    const target = resolve(input.slice("capture:".length));
    assert.ok(page && dirname(target) === join(homedir(), "Desktop")
      && /^pideck-credentials-.+\.png$/.test(basename(target)), "Capture requires an owned review filename on Desktop.");
    assert.ok(await lstat(target).then(() => false, error => error.code === "ENOENT"), "Refusing to overwrite an existing screenshot.");
    await writeFile(target, await page.screenshot({ type: "png" }), { flag: "wx", mode: 0o600 });
    say(`CAPTURED ${target}`);
    return;
  }
  if (input === "close") {
    await closeApp(); phase = "closed-profile-retained"; await record();
    say(`CLOSED own app. Temporary profile retained: ${profile}`);
    return;
  }
  if (active) { say(`WAITING: ${activeName} is still running. Use status; no further action has been counted as a pass.`); return; }
  if (input === "seed") return seed();
  if (input === "unlock") return unlock();
  if (input === "observe:none") return observe(false);
  if (input === "observe:prompt") return observe(true);
  if (input === "next") {
    assert.ok(baseline && ["seeded", "cold-read-observed"].includes(phase), "Finish and observe the current round before next.");
    await closeApp();
    return launch();
  }
  if (input === "cleanup") { await cleanup(); lines.close(); return; }
  say("Unknown command. Type help.");
}
function dispatch(input) {
  const name = input.trim();
  if (!name) return;
  if (name === "status" || name === "help" || active) {
    void command(name).catch(() => say("Command unavailable; profile retained. No verification pass was recorded."));
    return;
  }
  activeName = name;
  active = command(name).catch(async () => {
    failed = true;
    phase = "failed-profile-retained";
    await record();
    // Never print provider exceptions, evaluated arguments, keys or ciphertext.
    say(`FAILED during ${name}. No PASS was recorded. Inspect status and the app; cleanup remains explicit.`);
  }).finally(() => { active = undefined; activeName = undefined; });
}
say(`OPT-IN real bundle: ${bundle}`);
say(`ASAR SHA256: ${asarHash}`);
say("Runtime identity: pideck; expected macOS service/account: pideck Safe Storage / pideck Key.");
say(`PRIVATE temporary profile: ${profile}`);
say("The first save may require manual system authorization. No password or ACL action is automated. No external model requests will be made.");
const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
lines.on("line", dispatch);
lines.once("close", async () => {
  if (cleaned) return;
  // EOF is not consent to delete the profile or to count pending work as passed.
  await closeApp().catch(() => {});
  process.exitCode = accepted() ? 0 : 1;
  say(`Session ended; own temporary files retained at ${root}. OS credential-store items were not removed.`);
});
await launch().catch(async () => {
  failed = true;
  phase = "launch-failed-profile-retained";
  await record();
  say("LAUNCH FAILED. No credential verification passed. Type status, close or cleanup.");
});
