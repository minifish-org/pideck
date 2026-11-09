import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareUpdaterTools } from "./update-assets.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const account = "works.pideck.desktop.update-signing";

// The official Sparkle tool reads the private key directly from Keychain. This
// release step publishes only a signed appcast; it never exports the key.
export async function signUpdate(archive, project = root) {
  if (process.platform !== "darwin") throw new Error("macOS update signing requires a macOS release builder.");
  archive = resolve(archive);
  const name = basename(archive);
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const match = /^Pideck-(\d+\.\d+\.\d+)-(arm64|x64)-mac\.zip$/.exec(name);
  if (!match || match[1] !== pkg.version) throw new Error("Sign the ZIP for this source version using its standard release filename.");
  const tools = await prepareUpdaterTools(project);
  const expected = (await readFile(join(project, "resources/updater-public-key.txt"), "utf8")).trim();
  const { stdout } = await run(tools.generateKeys, ["--account", account, "-p"]);
  if (stdout.trim() !== expected) throw new Error("The local release signing key does not match the application's embedded public key.");
  const staging = await mkdtemp(join(dirname(archive), ".update-signing-"));
  try {
    await cp(archive, join(staging, name));
    const notes = join(dirname(archive), name.replace(/\.zip$/, ".md"));
    const text = await readFile(notes, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; });
    if (text) await writeFile(join(staging, basename(notes)), text);
    await run(tools.generateAppcast, ["--account", account, "--embed-release-notes",
      "--download-url-prefix", `https://github.com/minifish-org/pideck/releases/download/v${pkg.version}/`, staging], { maxBuffer: 2 * 1024 * 1024 });
    const appcast = join(staging, "appcast.xml");
    await run(tools.signUpdate, ["--account", account, "--verify", appcast]);
    const contents = await readFile(appcast, "utf8");
    if (!contents.includes("sparkle:edSignature=") || !contents.includes(`<sparkle:version>${pkg.version}</sparkle:version>`)) {
      throw new Error("The generated appcast does not contain a signed update for the source version.");
    }
    const destination = join(dirname(archive), "appcast.xml");
    await cp(appcast, destination);
    console.log(`Prepared authenticated macOS update feed: ${destination}`);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: npm run sign:update -- release/Pideck-VERSION-arm64-mac.zip");
  await signUpdate(process.argv[2]);
}
