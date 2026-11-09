import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";
import { _electron } from "playwright";
import { openSmokeProvider } from "./smoke-provider.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repository, "output", "auto-update");
const toolkitDigest = "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27";
const versions = { installed: "99.0.0", update: "99.0.1" };
const json = value => JSON.stringify(value, null, 2) + "\n";
const exists = path => stat(path).then(() => true, () => false);
const xml = value => String(value).replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);

function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
}

function readInfo(appPath) {
  return JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")]));
}

function isolatedEnvironment(endpoint) {
  // Do not inherit provider credentials, Electron test switches, or other app
  // settings. These two synthetic Azure values reach only the local provider.
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "__CF_USER_TEXT_ENCODING"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...environment, AZURE_OPENAI_API_KEY: "pideck-smoke-key", AZURE_OPENAI_BASE_URL: endpoint };
}

function ownProcesses(executable) {
  return command("/bin/ps", ["-axo", "pid=,command="]).split("\n")
    .map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .filter(([, , commandLine]) => commandLine === executable || commandLine.startsWith(executable + " "))
    .map(([, pid]) => Number(pid));
}

async function toolkit(directory) {
  const archive = join(outputRoot, "sparkle-spike", "Sparkle-2.10.1.tar.xz");
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), toolkitDigest,
    "The official Sparkle toolkit does not match its pinned GitHub asset digest.");
  const kit = join(directory, "sparkle-kit");
  await mkdir(kit);
  command("/usr/bin/tar", ["-xJf", archive, "-C", kit]);
  const signer = join(kit, "bin", "sign_update");
  assert.ok(await exists(signer));
  return signer;
}

async function unpackedManifest(root) {
  const entries = [];
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? prefix + "/" + name : name;
      const file = join(directory, name);
      const information = await lstat(file);
      const entry = { path, mode: information.mode & 0o7777 };
      if (information.isSymbolicLink()) entries.push({ ...entry, type: "link", target: await readlink(file) });
      else if (information.isDirectory()) { entries.push({ ...entry, type: "directory" }); await walk(file, path); }
      else {
        assert.ok(information.isFile(), `Unexpected native asset type: ${path}.`);
        entries.push({ ...entry, type: "file", size: information.size,
          sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
      }
    }
  }
  if (await exists(root)) await walk(root);
  return entries;
}

async function patchCandidate(base, candidate, { name, identity, version, publicKey, feedUrl, directory }) {
  await mkdir(dirname(candidate), { recursive: true });
  command("/usr/bin/ditto", [base, candidate]);
  const archive = join(candidate, "Contents", "Resources", "app.asar");
  const nativeAssets = await unpackedManifest(archive + ".unpacked");
  const extracted = join(directory, `asar-${version}`);
  const originalFiles = asar.listPackage(archive).map(path => path.replace(/^\//, ""));
  const unpackedFiles = originalFiles.filter(path => {
    const entry = asar.statFile(archive, path, false);
    return entry.unpacked && !("files" in entry);
  });
  const unpackedDirectories = originalFiles.filter(path => {
    const entry = asar.statFile(archive, path, false);
    return entry.unpacked && "files" in entry;
  }).filter((path, _, paths) => !paths.some(parent => path !== parent && path.startsWith(parent + "/")));
  asar.extractAll(archive, extracted);
  const unpackedMetadata = await Promise.all([...unpackedDirectories, ...unpackedFiles].map(async path => {
    const file = join(archive + ".unpacked", path);
    const information = await lstat(file);
    const mode = information.mode & 0o7777;
    const link = information.isSymbolicLink() ? await readlink(file) : undefined;
    // ASAR headers do not necessarily record executable bits for unpacked
    // assets. The original on-disk tree is authoritative for native helpers.
    if (!link) await chmod(join(extracted, path), mode);
    return { path, mode, link, directory: information.isDirectory() };
  }));
  const metadataPath = join(extracted, "package.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  // Sparkle relaunches without Playwright's argv. Patch every Electron name
  // source, so its default profile remains isolated even after that relaunch.
  Object.assign(metadata, { name, productName: name, version });
  await writeFile(metadataPath, json(metadata));
  const staged = join(directory, `candidate-${version}.asar`);
  const unpackedPaths = unpackedFiles.map(path => join(extracted, path));
  assert.ok([...unpackedPaths, ...unpackedDirectories].every(path => !/[{},*?\[\]()!]/.test(path)), "An unpacked path needs explicit glob escaping.");
  const pattern = paths => paths.length === 1 ? paths[0] : `{${paths.join(",")}}`;
  await asar.createPackageWithOptions(extracted, staged, {
    ...(unpackedPaths.length ? { unpack: pattern(unpackedPaths) } : {}),
    ...(unpackedDirectories.length ? { unpackDir: pattern(unpackedDirectories) } : {}),
  });
  const newFiles = asar.listPackage(staged).map(path => path.replace(/^\//, ""));
  assert.deepEqual(newFiles.sort(), originalFiles.sort(), "Repacking changed the application file set.");
  for (const path of originalFiles) {
    const before = asar.statFile(archive, path, false);
    const after = asar.statFile(staged, path, false);
    assert.equal(Boolean(after.unpacked), Boolean(before.unpacked), `ASAR unpacking changed for ${path}.`);
    if ("link" in before) assert.equal(after.link, before.link, `ASAR link changed for ${path}.`);
    if (path !== "package.json" && !("files" in before) && !("link" in before)) {
      assert.equal(createHash("sha256").update(asar.extractFile(staged, path)).digest("hex"),
        createHash("sha256").update(asar.extractFile(archive, path)).digest("hex"), `Application code changed in ${path}.`);
    }
  }
  await copyFile(staged, archive);
  // Only packed package.json changed. Preserve the already-copied native tree
  // rather than replacing it with an extraction that may lose Unix modes.
  assert.deepEqual(await unpackedManifest(archive + ".unpacked"), nativeAssets,
    "ASAR repacking changed original unpacked asset modes, links or bytes.");
  asar.uncache(archive);
  const headerHash = createHash("sha256").update(asar.getRawHeader(staged).headerString).digest("hex");
  command("/usr/bin/python3", ["-c", `import json,plistlib,sys
p=sys.argv[1]
with open(p,'rb') as f:d=plistlib.load(f)
updates=json.loads(sys.argv[2])
integrity=d.get('ElectronAsarIntegrity',{})
assert 'Resources/app.asar' in integrity, 'Packaged ASAR integrity is missing'
integrity['Resources/app.asar']={'algorithm':'SHA256','hash':sys.argv[3]}
d.update(updates)
with open(p,'wb') as f:plistlib.dump(d,f)
`, join(candidate, "Contents", "Info.plist"), JSON.stringify({
    CFBundleIdentifier: identity, CFBundleName: name, CFBundleDisplayName: name,
    CFBundleVersion: version, CFBundleShortVersionString: version,
    SUEnableAutomaticChecks: false,
    SUFeedURL: feedUrl, SUPublicEDKey: publicKey, SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true, SUSignedFeedFailureExpirationInterval: 0,
  }), headerHash]);
  // Electron locates each child helper by CFBundleName before JavaScript runs.
  // Keep those bundle/executable names in sync with the isolated parent name.
  const frameworks = join(candidate, "Contents", "Frameworks");
  for (const entry of await readdir(frameworks)) {
    if (!entry.endsWith(".app")) continue;
    const helper = join(frameworks, entry);
    const info = readInfo(helper);
    const suffix = / Helper(?: \((Renderer|GPU|Plugin)\))?$/.exec(info.CFBundleExecutable ?? "");
    if (!suffix) continue;
    const executableName = name + suffix[0];
    await rename(join(helper, "Contents", "MacOS", info.CFBundleExecutable), join(helper, "Contents", "MacOS", executableName));
    command("/usr/bin/python3", ["-c", `import json,plistlib,sys
p=sys.argv[1]
with open(p,'rb') as f:d=plistlib.load(f)
d.update(json.loads(sys.argv[2]))
with open(p,'wb') as f:plistlib.dump(d,f)
`, join(helper, "Contents", "Info.plist"), JSON.stringify({ CFBundleExecutable: executableName,
      CFBundleName: executableName, CFBundleDisplayName: executableName,
      CFBundleIdentifier: identity + ".helper" + (suffix[1] ? "." + suffix[1] : ""), CFBundleVersion: version })]);
    await rename(helper, join(frameworks, executableName + ".app"));
  }
  // Preserve the base app's hardened runtime flags and entitlements. Only the
  // disposable identity changes; no signature/integrity check is disabled.
  command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements,flags,runtime", candidate]);
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", candidate]);
  assert.deepEqual(await unpackedManifest(archive + ".unpacked"), nativeAssets,
    "Final signing changed original unpacked asset modes, links or bytes.");
  for (const original of unpackedMetadata) {
    const file = join(archive + ".unpacked", original.path);
    const information = await lstat(file);
    assert.deepEqual({ mode: information.mode & 0o7777,
      link: information.isSymbolicLink() ? await readlink(file) : undefined, directory: information.isDirectory() },
    { mode: original.mode, link: original.link, directory: original.directory }, `Native asset permissions or link changed for ${original.path}.`);
  }
  const info = readInfo(candidate);
  assert.equal(info.CFBundleIdentifier, identity);
  assert.equal(info.CFBundleName, name);
  assert.equal(info.ElectronAsarIntegrity["Resources/app.asar"].hash, headerHash);
  const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert.deepEqual([packaged.name, packaged.productName, packaged.version], [name, name, version]);
  await rm(extracted, { recursive: true, force: true });
  await rm(staged, { force: true });
  await rm(staged + ".unpacked", { recursive: true, force: true });
  return join(candidate, "Contents", "MacOS", info.CFBundleExecutable);
}

function readMetadata(profile, { offline = false } = {}) {
  return JSON.parse(command("/usr/bin/python3", ["-c", `import json,sqlite3,sys,pathlib
p=pathlib.Path(sys.argv[1])
offline=sys.argv[2]=='offline'
def connect(name):
 file=p/name
 if offline:
  assert not pathlib.Path(str(file)+'-wal').exists(), 'Offline immutable inspection requires a checkpointed database'
 return sqlite3.connect(file.as_uri()+'?mode=ro'+('&immutable=1' if offline else ''),uri=True)
db=connect('workspace.sqlite')
db.row_factory=sqlite3.Row
result={name:[dict(row) for row in db.execute('SELECT * FROM '+name+' ORDER BY id')] for name in ['projects','sessions']}
result['workspaceIntegrity']=db.execute('PRAGMA quick_check').fetchone()[0]
db.close()
db=connect('conversations.sqlite')
result['conversationIntegrity']=db.execute('PRAGMA quick_check').fetchone()[0]
db.close()
print(json.dumps(result))
`, profile, offline ? "offline" : "live"]));
}

export async function prepareUpdateAcceptance({ baseApp, directory } = {}) {
  assert.equal(process.platform, "darwin", "This acceptance harness exercises native macOS Sparkle updates.");
  assert.ok(baseApp && isAbsolute(baseApp), "Pass the absolute path to a freshly built Pideck.app.");
  assert.ok(await exists(join(baseApp, "Contents", "Resources", "native", "pideck-sparkle.node")));
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", baseApp]);
  const id = randomUUID();
  const name = `pideck-update-verification-${id}`;
  const identity = `works.pideck.update-verification.${id}`;
  const run = resolve(directory ?? join(outputRoot, `native-acceptance-${Date.now()}-${id.slice(0, 8)}`));
  const inside = relative(outputRoot, run);
  assert.ok(inside && !inside.startsWith(".." + sep) && inside !== ".." && !isAbsolute(inside), "Evidence must stay under output/auto-update.");
  assert.equal(await exists(run), false, "Use a new acceptance directory.");
  const profile = join(homedir(), "Library", "Application Support", name);
  assert.equal(await exists(profile), false, "The verification profile must start empty.");
  await mkdir(run, { recursive: true, mode: 0o700 });
  const operations = join(run, "operations.jsonl");
  const lifecycle = join(run, "native-lifecycle.jsonl");
  const readiness = join(run, "readiness.json");
  const feedMode = join(run, "feed-mode.json");
  const installed = join(run, "installed", "Pideck Update Verification.app");
  const candidate = join(run, "candidate", "Pideck Update Verification.app");
  const project = join(run, "project");
  const privateFile = join(run, "ephemeral-signing-seed.txt");
  const record = (event, details = {}) => appendFileSync(operations, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + "\n");
  const requests = [];
  let app;
  let page;
  let provider;
  let seeded;
  let executable;
  let closed = false;
  let artifactsReady = false;
  await writeFile(feedMode, json({ mode: "current" }));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const mode = JSON.parse(await readFile(feedMode, "utf8")).mode;
      const allowed = new Set(["current", "good", "tampered-archive", "tampered-feed"]);
      assert.ok(allowed.has(mode), "Unknown feed mode.");
      const row = { at: new Date().toISOString(), path: url.pathname, mode };
      requests.push(row);
      record("http-request", row);
      let file;
      if (url.pathname === "/feed.xml" && artifactsReady) file = join(run, `feed-${mode}.xml`);
      else if (url.pathname === "/good.zip" && artifactsReady) file = join(run, "good.zip");
      else if (url.pathname === "/tampered.zip" && artifactsReady) file = join(run, "tampered.zip");
      if (!file) { response.writeHead(404); response.end(); return; }
      const size = (await stat(file)).size;
      response.writeHead(200, { "Content-Type": file.endsWith(".xml") ? "application/rss+xml" : "application/zip",
        "Content-Length": size, "Cache-Control": "no-store" });
      createReadStream(file).pipe(response);
    } catch (error) { record("http-error", { message: error.message }); response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const feedUrl = `http://127.0.0.1:${server.address().port}/feed.xml`;
  const publicState = () => ({ run, name, identity, profile, installed, candidate, executable, project, feedUrl,
    feedMode, readiness, operations, lifecycle, versions, ...(seeded ? { seeded } : {}) });
  async function saveState() { await writeFile(readiness, json(publicState())); }
  try {
    const signer = await toolkit(run);
    const seed = randomBytes(32);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    await writeFile(privateFile, seed.toString("base64") + "\n", { mode: 0o600 });
    const configuration = { name, identity, publicKey, feedUrl, directory: run };
    executable = await patchCandidate(baseApp, installed, { ...configuration, version: versions.installed });
    await patchCandidate(baseApp, candidate, { ...configuration, version: versions.update });
    const archive = join(run, "good.zip");
    command("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", candidate, archive]);
    const size = (await stat(archive)).size;
    const signature = command(signer, ["--ed-key-file", privateFile, "-p", archive]).trim();
    command(signer, ["--verify", "--ed-key-file", privateFile, archive, signature]);
    await copyFile(archive, join(run, "tampered.zip"));
    appendFileSync(join(run, "tampered.zip"), Buffer.from([0x42]));
    for (const [mode, version, archiveName, length] of [["good", versions.update, "good.zip", size],
      ["tampered-archive", versions.update, "tampered.zip", size + 1], ["current", versions.installed, "good.zip", size]]) {
      const feed = join(run, `feed-${mode}.xml`);
      await writeFile(feed, `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Pideck isolated update acceptance</title><item><title>Verification ${xml(version)}</title><sparkle:version>${xml(version)}</sparkle:version><sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><enclosure url="${xml(new URL(archiveName, feedUrl))}" sparkle:edSignature="${xml(signature)}" length="${length}" type="application/octet-stream" /></item></channel></rss>`);
      command(signer, ["--ed-key-file", privateFile, feed]);
      command(signer, ["--verify", "--ed-key-file", privateFile, feed]);
    }
    await writeFile(join(run, "feed-tampered-feed.xml"), (await readFile(join(run, "feed-good.xml"), "utf8"))
      .replace("Pideck isolated update acceptance", "Pideck altered update acceptance"));
    await assert.rejects(async () => command(signer, ["--verify", "--ed-key-file", privateFile, join(run, "tampered.zip"), signature]),
      "The tampered archive unexpectedly passed the official verifier.");
    await assert.rejects(async () => command(signer, ["--verify", "--ed-key-file", privateFile, join(run, "feed-tampered-feed.xml")]),
      "The tampered feed unexpectedly passed the official verifier.");
    await mkdir(project);
    await writeFile(join(project, "README.md"), "# Isolated Pideck update acceptance\nThis directory contains only disposable verification data.\n");
    artifactsReady = true;
    record("prepared", { baseApp, ...publicState(), publicKey, archiveBytes: size });
    await saveState();
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    throw error;
  } finally { await rm(privateFile, { force: true }); }

  async function launch({ reopening = false } = {}) {
    assert.equal(closed, false);
    assert.deepEqual(ownProcesses(executable), [], "Close the verification app before attaching a new test launch.");
    const info = readInfo(installed);
    const metadata = JSON.parse(asar.extractFile(join(installed, "Contents", "Resources", "app.asar"), "package.json").toString());
    assert.deepEqual([info.CFBundleIdentifier, info.CFBundleName, info.CFBundleDisplayName, metadata.name, metadata.productName],
      [identity, name, name, name, name]);
    provider ??= await openSmokeProvider();
    try {
      app = await _electron.launch({ executablePath: executable, args: [], env: isolatedEnvironment(provider.endpoint), timeout: 30_000 });
    } catch (error) {
      record("launch-failed", { message: error.stack ?? String(error) });
      await close();
      throw error;
    }
    const actual = await app.evaluate(({ app, Notification }) => {
      Notification.isSupported = () => false;
      return { name: app.getName(), data: app.getPath("userData"), version: app.getVersion(), packaged: app.isPackaged,
        pid: process.pid, metrics: app.getAppMetrics().map(({ pid, name }) => ({ pid, name })) };
    });
    // This guard precedes every project/model request, including reopen. Passing
    // --user-data-dir here would hide a broken native-relaunch identity.
    assert.deepEqual({ name: actual.name, data: actual.data, packaged: actual.packaged }, { name, data: profile, packaged: true });
    assert.equal(actual.version, reopening ? versions.update : versions.installed);
    record(reopening ? "verification-reopened" : "verification-launched", actual);
    await app.evaluate(({ app }, log) => {
      const { appendFileSync } = process.getBuiltinModule("node:fs");
      const record = event => appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid,
        version: app.getVersion(), name: app.getName(), profile: app.getPath("userData"),
        workspacePids: app.getAppMetrics().filter(metric => metric.name === "Pideck workspace").map(metric => metric.pid) }) + "\n");
      app.on("before-quit", () => record("before-quit"));
      app.on("will-quit", () => record("will-quit"));
      process.once("exit", () => record("exit"));
    }, lifecycle);
    app.process().stdout?.on("data", bytes => appendFileSync(join(run, "app.stdout.log"), bytes));
    app.process().stderr?.on("data", bytes => appendFileSync(join(run, "app.stderr.log"), bytes));
    page = await app.firstWindow();
    page.on("pageerror", error => record("renderer-error", { message: error.message }));
    await page.waitForFunction(() => Boolean(window.pideck));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820));
    return { app, page, actual };
  }

  async function capture(label) {
    assert.ok(page);
    for (const appearance of ["dark", "light"]) {
      await app.evaluate(({ Menu, BrowserWindow }, appearance) => {
        const item = Menu.getApplicationMenu().getMenuItemById(`appearance-${appearance}`);
        assertEnabled(item);
        item.click({}, BrowserWindow.getAllWindows()[0]);
        function assertEnabled(item) { if (!item?.enabled) throw new Error("Appearance menu is unavailable."); }
      }, appearance);
      await page.waitForFunction(appearance => document.documentElement.dataset.colorMode === appearance, appearance);
      await page.screenshot({ path: join(run, `${label}-${appearance}.png`) });
    }
  }

  async function launchAndSeed() {
    assert.equal(seeded, undefined, "This acceptance profile is already seeded.");
    await launch();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await page.getByRole("button", { name: /^Open (?:a project )?folder$/i }).click();
    const prompt = page.getByRole("textbox", { name: "Message Pideck", exact: true });
    await prompt.waitFor();
    const catalog = await page.evaluate(() => window.pideck.invoke("model:list"));
    const azure = catalog.models.find(model => model.provider === "azure" && model.id === "gpt-4.1");
    assert.ok(azure, "The isolated local Azure model is unavailable.");
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const menu = page.getByRole("region", { name: "Choose a model" });
    await menu.getByRole("searchbox", { name: "Search models" }).fill("gpt-4.1");
    await menu.getByRole("button", { name: /\bAzure\b/i }).filter({ has: page.getByText(azure.name, { exact: true }) }).click();
    await menu.waitFor({ state: "hidden" });
    const marker = "Queue hold SAVE";
    const original = "UPDATE original queued message";
    const revised = "UPDATE unsaved edited queued message";
    const following = "UPDATE second queued message";
    const draft = "UPDATE ordinary unsent draft";
    await prompt.fill(marker);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await provider.waitForGate(marker);
    const queue = page.getByRole("list", { name: "Queued messages" });
    for (const text of [original, following]) {
      await prompt.fill(text);
      await prompt.press("Enter");
      await queue.getByText(text, { exact: true }).waitFor();
    }
    const ids = await queue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId));
    await prompt.fill(draft);
    await queue.getByRole("listitem").filter({ hasText: original }).getByRole("button", { name: "Edit message", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit queued message", exact: true });
    await page.waitForFunction(text => document.querySelector('textarea[aria-label="Edit queued message"]')?.value === text, original);
    await editor.fill(revised);
    provider.releaseGate(marker);
    await page.getByText(`${marker}: current run finished.`, { exact: true }).waitFor();
    await page.locator(".run-clock[data-ended-at]").waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel run", exact: true }).isDisabled(), true);
    assert.deepEqual(await queue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId)), ids);
    assert.equal(await editor.inputValue(), revised);
    assert.equal(provider.requests.length, 1, "Held queue entries executed before explicit save or cancel.");
    const projects = await page.evaluate(() => window.pideck.invoke("project:list"));
    assert.equal(projects.length, 1);
    assert.equal(projects[0].directory, project);
    const sessions = await page.evaluate(projectId => window.pideck.invoke("session:list", { projectId }), projects[0].id);
    assert.equal(sessions.length, 1);
    await page.waitForFunction(({ projectId, sessionId, draft, revised }) => {
      const saved = JSON.parse(localStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`) ?? "null");
      return saved?.text === draft && saved?.queueEdit?.text === revised;
    }, { projectId: projects[0].id, sessionId: sessions[0].id, draft, revised });
    const metadata = readMetadata(profile);
    assert.equal(metadata.workspaceIntegrity, "ok");
    assert.equal(metadata.conversationIntegrity, "ok");
    seeded = { marker, original, revised, following, draft, ids, projects, sessions, metadata, modelRequests: provider.requests.length,
      localStorage: await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("pideck.")).map(key => [key, localStorage.getItem(key)]))),
      mainPid: app.process().pid,
      workspacePids: await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === "Pideck workspace").map(metric => metric.pid)) };
    assert.ok(seeded.workspacePids.length);
    await capture("before-update");
    await setFeedMode("good");
    await saveState();
    record("ui-ready", { ...publicState(), modelRequests: provider.requests.length });
    return { ...publicState(), app, page };
  }

  async function setFeedMode(mode) {
    assert.ok(["current", "good", "tampered-archive", "tampered-feed"].includes(mode));
    await writeFile(feedMode, json({ mode }));
    record("feed-mode", { mode });
  }

  async function inspectInstallation() {
    const info = readInfo(installed);
    const pids = ownProcesses(executable);
    const metadata = readMetadata(profile, { offline: pids.length === 0 });
    const events = await readFile(lifecycle, "utf8").then(text => text.trim().split("\n").filter(Boolean).map(JSON.parse), () => []);
    const result = { version: info.CFBundleVersion, bundleId: info.CFBundleIdentifier, profile, pids, metadata, events, requests };
    await writeFile(join(run, "inspection.json"), json(result));
    return result;
  }

  async function reopenAndVerify() {
    assert.ok(seeded, "Seed a real project/session before updating.");
    assert.equal(readInfo(installed).CFBundleVersion, versions.update, "The installation did not swap to the new version.");
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
    const inspection = await inspectInstallation();
    assert.ok(inspection.events.some(event => event.event === "will-quit" && event.version === versions.installed
      && event.workspacePids.length === 0), "The old workspace must close before native installation quits the app.");
    assert.deepEqual(inspection.metadata.projects, seeded.metadata.projects, "Project identity was lost.");
    assert.deepEqual(inspection.metadata.sessions.map(({ id, conversationId, projectId }) => ({ id, conversationId, projectId })),
      seeded.metadata.sessions.map(({ id, conversationId, projectId }) => ({ id, conversationId, projectId })));
    await launch({ reopening: true });
    const queue = page.getByRole("list", { name: "Queued messages" });
    const editor = page.getByRole("textbox", { name: "Edit queued message", exact: true });
    await queue.waitFor();
    await page.waitForFunction(text => {
      const editor = document.querySelector('textarea[aria-label="Edit queued message"]');
      return editor && !editor.readOnly && editor.value === text;
    }, seeded.revised);
    assert.equal(await editor.inputValue(), seeded.revised);
    assert.deepEqual(await queue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId)), seeded.ids);
    const saved = await page.evaluate(({ projectId, sessionId }) => JSON.parse(localStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`)),
      { projectId: seeded.projects[0].id, sessionId: seeded.sessions[0].id });
    assert.equal(saved.text, seeded.draft);
    assert.equal(saved.queueEdit.text, seeded.revised);
    await page.getByText(`${seeded.marker}: current run finished.`, { exact: true }).waitFor();
    await page.locator(".run-clock[data-ended-at]").waitFor();
    assert.equal(provider.requests.length, seeded.modelRequests, "Reopening executed held queued messages.");
    assert.deepEqual(provider.failures, []);
    await capture("after-update");
    const final = await inspectInstallation();
    assert.equal(final.metadata.workspaceIntegrity, "ok");
    assert.equal(final.metadata.conversationIntegrity, "ok");
    record("acceptance-passed", { version: final.version, projectId: seeded.projects[0].id, sessionId: seeded.sessions[0].id });
    return final;
  }

  async function close({ quit = false, removeProfile = false } = {}) {
    if (closed) return;
    if (quit && app) await app.close();
    if (removeProfile) {
      assert.deepEqual(ownProcesses(executable), [], "Close every verification app before removing its profile.");
      assert.ok(profile.endsWith(sep + name) && name.startsWith("pideck-update-verification-"));
      await rm(profile, { recursive: true, force: true });
      await rm(join(homedir(), "Library", "Caches", identity), { recursive: true, force: true });
      if (await exists(join(homedir(), "Library", "Preferences", identity + ".plist"))) command("/usr/bin/defaults", ["delete", identity]);
    }
    await provider?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(privateFile, { force: true });
    closed = true;
    record("harness-closed", { removeProfile, remainingAppPids: ownProcesses(executable) });
  }

  return { ...publicState(), launchAndSeed, reopenAndVerify, inspectInstallation, capture, setFeedMode, close,
    get app() { return app; }, get page() { return page; } };
}

// A native relaunch intentionally has no debugger or test launch arguments.
// After the reviewer quits that window normally, verify the installed payload
// in a new debugger connection without rebuilding or reseeding the profile.
export async function verifyInstalledUpdate(readinessPath) {
  const state = JSON.parse(await readFile(readinessPath, "utf8"));
  const { name, identity, installed, executable, profile, seeded, run } = state;
  assert.match(name, /^pideck-update-verification-[0-9a-f-]{36}$/);
  assert.equal(identity, "works.pideck.update-verification." + name.slice("pideck-update-verification-".length));
  assert.equal(profile, join(homedir(), "Library", "Application Support", name));
  assert.equal(executable, join(installed, "Contents", "MacOS", readInfo(installed).CFBundleExecutable));
  assert.deepEqual(ownProcesses(executable), [], "Quit the natively relaunched verification app before post-update inspection.");
  assert.ok(seeded?.metadata && seeded.ids.length === 2);
  const info = readInfo(installed);
  assert.deepEqual([info.CFBundleIdentifier, info.CFBundleName, info.CFBundleDisplayName, info.CFBundleVersion],
    [identity, name, name, versions.update]);
  const archive = join(installed, "Contents", "Resources", "app.asar");
  asar.uncache(archive);
  const packageMetadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert.deepEqual([packageMetadata.name, packageMetadata.productName, packageMetadata.version], [name, name, versions.update]);
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
  const before = readMetadata(profile, { offline: true });
  assert.deepEqual(before.projects, seeded.metadata.projects);
  assert.deepEqual(before.sessions.map(({ id, conversationId, projectId }) => ({ id, conversationId, projectId })),
    seeded.metadata.sessions.map(({ id, conversationId, projectId }) => ({ id, conversationId, projectId })));
  const lifecycle = (await readFile(state.lifecycle, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(lifecycle.some(event => event.event === "will-quit" && event.pid === seeded.mainPid
    && event.version === versions.installed && event.workspacePids.length === 0),
  "The old trusted workspace must be closed before installation quits the app.");
  const provider = await openSmokeProvider();
  let app;
  let result;
  try {
    app = await _electron.launch({ executablePath: executable, args: [], env: isolatedEnvironment(provider.endpoint), timeout: 30_000 });
    const actual = await app.evaluate(({ app, Notification }) => {
      Notification.isSupported = () => false;
      return { name: app.getName(), profile: app.getPath("userData"), version: app.getVersion(), packaged: app.isPackaged, pid: process.pid };
    });
    assert.deepEqual({ ...actual, pid: undefined }, { name, profile, version: versions.update, packaged: true, pid: undefined });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.pideck));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820));
    const queue = page.getByRole("list", { name: "Queued messages" });
    await queue.waitFor();
    await page.waitForFunction(text => {
      const editor = document.querySelector('textarea[aria-label="Edit queued message"]');
      return editor && !editor.readOnly && editor.value === text;
    }, seeded.revised);
    const queueIds = await queue.getByRole("listitem").evaluateAll(rows => rows.map(row => row.dataset.queueId));
    assert.deepEqual(queueIds, seeded.ids);
    const restored = await page.evaluate(({ projectId, sessionId }) => ({
      draft: JSON.parse(localStorage.getItem(`pideck.draft.v1/${projectId}/${sessionId}`)),
      workspace: JSON.parse(localStorage.getItem("pideck.workspace.v1")),
    }), { projectId: seeded.projects[0].id, sessionId: seeded.sessions[0].id });
    assert.equal(restored.draft.text, seeded.draft);
    assert.equal(restored.draft.queueEdit.text, seeded.revised);
    assert.equal(restored.draft.queueEdit.id, Number(seeded.ids[0]));
    assert.equal(restored.workspace.projectId, seeded.projects[0].id);
    assert.equal(restored.workspace.sessions[seeded.projects[0].id], seeded.sessions[0].id);
    await page.getByText(`${seeded.marker}: current run finished.`, { exact: true }).waitFor();
    await page.locator(".run-clock[data-ended-at]").waitFor();
    const projects = await page.evaluate(() => window.pideck.invoke("project:list"));
    assert.deepEqual(projects, seeded.projects);
    const sessions = await page.evaluate(projectId => window.pideck.invoke("session:list", { projectId }), seeded.projects[0].id);
    assert.deepEqual(sessions.map(({ id, projectId, title }) => ({ id, projectId, title })),
      seeded.sessions.map(({ id, projectId, title }) => ({ id, projectId, title })));
    const screenshots = [];
    for (const appearance of ["dark", "light"]) {
      await app.evaluate(({ Menu, BrowserWindow }, appearance) => {
        const item = Menu.getApplicationMenu().getMenuItemById(`appearance-${appearance}`);
        if (!item?.enabled) throw new Error("Appearance menu is unavailable.");
        item.click({}, BrowserWindow.getAllWindows()[0]);
      }, appearance);
      await page.waitForFunction(appearance => document.documentElement.dataset.colorMode === appearance, appearance);
      const path = join(run, `after-update-${appearance}.png`);
      await page.screenshot({ path });
      screenshots.push(path);
    }
    assert.deepEqual(provider.failures, []);
    assert.equal(provider.requests.length, 0, "Reopening submitted held queued messages or an unsent draft.");
    result = { status: "passed", actual, projects, sessions, queueIds, restored, lifecycle, screenshots,
      postUpdateModelRequests: provider.requests.length, offlineMetadata: before, liveMetadata: readMetadata(profile) };
    await writeFile(join(run, "post-update-verification.json"), json(result));
  } finally {
    await app?.close();
    await provider.close();
  }
  result.closedMetadata = readMetadata(profile, { offline: true });
  assert.equal(result.closedMetadata.workspaceIntegrity, "ok");
  assert.equal(result.closedMetadata.conversationIntegrity, "ok");
  assert.deepEqual(ownProcesses(executable), []);
  await writeFile(join(run, "post-update-verification.json"), json(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, baseApp] = process.argv.slice(2);
  if (mode === "verify" && baseApp) {
    const result = await verifyInstalledUpdate(resolve(baseApp));
    console.log(json({ status: result.status, version: result.actual.version, screenshots: result.screenshots }));
    process.exit(0);
  }
  assert.ok(["prepare", "launch"].includes(mode) && baseApp,
    "Usage: node scripts/smoke-updates.mjs prepare|launch /absolute/path/Pideck.app\n       node scripts/smoke-updates.mjs verify /absolute/path/readiness.json\nprepare serves signed fixtures without starting an app; launch also seeds an isolated project and held queue.");
  const harness = await prepareUpdateAcceptance({ baseApp: resolve(baseApp) });
  try {
    if (mode === "launch") await harness.launchAndSeed();
  } catch (error) {
    await harness.close({ quit: true });
    throw error;
  }
  console.log(json({ status: mode === "launch" ? "ui-ready" : "prepared-no-app-launched", readiness: harness.readiness,
    installed: harness.installed, feed: harness.feedUrl, feedMode: harness.feedMode, profile: harness.profile }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void harness.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  });
}
