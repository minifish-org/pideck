import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch } from "builder-util";

const run = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
export const sparkleVersion = "2.10.1";
const sparkleChecksum = "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27";
const electronVersion = "45.2.3";
// Official artifacts.electronjs.org/headers/dist/v45.2.3/SHASUMS256.txt.
const headerChecksum = "5300f8e7965734f7cc1aec0c89ce8c0b68644129b858fb0a530ebbd9cd4a4284";
const napiVersion = 8;
const minimumSystemVersion = "14.0";
const frameworkPath = "Frameworks/Sparkle.framework";
const nativePath = "Resources/native/pideck-sparkle.node";
const manifestPath = "Resources/updater/manifest.json";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function archive(cache, name, url, checksum) {
  const path = join(cache, name);
  if (!await access(path).then(() => true, () => false)) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      console.log(`Preparing native updater: downloading ${name}.`);
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Updater dependency returned HTTP ${response.status}.`);
      const hash = createHash("sha256");
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      }), createWriteStream(temporary, { flags: "wx" }));
      if (hash.digest("hex") !== checksum) throw new Error(`Updater dependency ${name} does not match its pinned checksum.`);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (await sha256(path) !== checksum) throw new Error(`Cached updater dependency ${name} does not match its pinned checksum.`);
  return path;
}

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory()) await walk(path, visit);
  }
}

async function validateLinks(root) {
  const base = await realpath(root);
  await walk(base, async (path, entry) => {
    if (!entry.isSymbolicLink()) return;
    const target = await readlink(path);
    const resolved = relative(base, await realpath(path));
    if (isAbsolute(target) || resolved === ".." || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
      throw new Error(`Native updater resource link escapes its bundle: ${relative(base, path)}`);
    }
  });
}

async function preparedHashes(root) {
  const result = {};
  for (const tree of [join(root, frameworkPath), join(root, "Resources")]) {
    await walk(tree, async (path, entry) => {
      const name = relative(root, path).split(sep).join("/");
      if (entry.isFile() && name !== manifestPath) result[name] = await sha256(path);
    });
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

/** Validate both the staging tree and an installed app's Contents directory.
 * Prepared hashes are checked before signing only: codesign legitimately alters
 * Mach-O binaries. Final packages retain upstream/source provenance in the
 * manifest and are authenticated by their final Sparkle archive signature.
 */
export async function validateUpdaterResources(contents, expected = {}) {
  const manifest = JSON.parse(await readFile(join(contents, manifestPath), "utf8"));
  if (manifest.schema !== 1 || manifest.platform !== "darwin" || !["arm64", "x64"].includes(manifest.arch)
      || manifest.sparkleVersion !== sparkleVersion || manifest.sparkleArchiveSha256 !== sparkleChecksum
      || manifest.electronVersion !== electronVersion || manifest.electronHeadersSha256 !== headerChecksum
      || manifest.napiVersion !== napiVersion || manifest.minimumSystemVersion !== minimumSystemVersion
      || manifest.framework !== frameworkPath || manifest.native !== nativePath
      || (expected.platform && manifest.platform !== expected.platform)
      || (expected.arch && manifest.arch !== expected.arch)) {
    throw new Error("Native updater manifest does not match its pinned dependencies or package target.");
  }
  const framework = join(contents, frameworkPath);
  await validateLinks(framework);
  for (const name of [nativePath, `${frameworkPath}/Versions/B/Sparkle`, `${frameworkPath}/Versions/B/Autoupdate`,
    `${frameworkPath}/Versions/B/Updater.app/Contents/MacOS/Updater`,
    `${frameworkPath}/Versions/B/Resources/Info.plist`, "Resources/updater/LICENSE.txt", "Resources/updater/NOTICE.txt"]) {
    const info = await stat(join(contents, name)).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) throw new Error(`Native updater resource is missing or empty: ${name}`);
  }
  if (await access(join(framework, "Versions/B/XPCServices")).then(() => true, () => false)) {
    throw new Error("Pideck is not App Sandbox-enabled and must not bundle unused Sparkle XPC services.");
  }
  const { stdout: version } = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-",
    join(framework, "Versions/B/Resources/Info.plist")]);
  if (version.trim() !== sparkleVersion) throw new Error("Bundled Sparkle framework version does not match its manifest.");
  const architecture = manifest.arch === "x64" ? "x86_64" : "arm64";
  for (const name of [nativePath, `${frameworkPath}/Versions/B/Sparkle`, `${frameworkPath}/Versions/B/Autoupdate`,
    `${frameworkPath}/Versions/B/Updater.app/Contents/MacOS/Updater`]) {
    await run("/usr/bin/lipo", [join(contents, name), "-verify_arch", architecture]);
  }
  const { stdout: libraries } = await run("/usr/bin/otool", ["-L", join(contents, nativePath)]);
  if (!libraries.includes("@rpath/Sparkle.framework/Versions/B/Sparkle")) {
    throw new Error("Native updater does not link the staged Sparkle framework.");
  }
  if (expected.verifyPreparedHashes) {
    const hashes = await preparedHashes(contents);
    if (JSON.stringify(hashes) !== JSON.stringify(manifest.preparedFiles)) {
      throw new Error("Native updater preparation hashes changed before signing.");
    }
  }
  return manifest;
}

export async function prepareUpdaterAssets(platform = process.platform, arch = process.arch, root = projectDirectory) {
  if (platform !== "darwin") return undefined;
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
    throw new Error("Native macOS updater assets require a macOS builder targeting arm64 or x64.");
  }
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const installedElectron = JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8"));
  if (packageInfo.devDependencies.electron !== electronVersion || installedElectron.version !== electronVersion) {
    throw new Error("Native updater Electron headers must match the project's pinned Electron version; update the audited header pin together.");
  }
  const assetRoot = join(root, "release/updater-assets");
  const cache = join(root, "release/updater-downloads");
  await mkdir(assetRoot, { recursive: true });
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(assetRoot, `.mac-${arch}-`));
  const destination = join(assetRoot, `mac-${arch}`);
  try {
    const sparkleArchive = await archive(cache, `Sparkle-${sparkleVersion}.tar.xz`,
      `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-${sparkleVersion}.tar.xz`, sparkleChecksum);
    const headersArchive = await archive(cache, `node-v${electronVersion}-headers.tar.gz`,
      `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`, headerChecksum);
    const sdk = join(staging, ".sdk");
    const headers = join(staging, ".headers");
    await mkdir(sdk);
    await mkdir(headers);
    // Only pinned, authenticated archive bytes reach the system extractor.
    await run("/usr/bin/tar", ["-xf", sparkleArchive, "-C", sdk]);
    await run("/usr/bin/tar", ["-xzf", headersArchive, "-C", headers, "--strip-components", "1"]);
    await mkdir(join(staging, "Frameworks"));
    await mkdir(join(staging, "Resources/native"), { recursive: true });
    await mkdir(join(staging, "Resources/updater"));
    await cp(join(sdk, "Sparkle.framework"), join(staging, frameworkPath), { recursive: true, verbatimSymlinks: true });
    // Electron's renderer sandbox is not macOS App Sandbox. Sparkle documents
    // excluding these services for a non-App-Sandbox application.
    await rm(join(staging, frameworkPath, "XPCServices"), { force: true });
    await rm(join(staging, frameworkPath, "Versions/B/XPCServices"), { recursive: true, force: true });
    const source = join(root, "native/updater.mm");
    await run("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-fblocks", "-fvisibility=hidden",
      "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", `-DNAPI_VERSION=${napiVersion}`,
      "-DNODE_GYP_MODULE_NAME=pideck_sparkle", "-I", join(headers, "include/node"),
      "-F", join(staging, "Frameworks"), "-framework", "Sparkle", "-framework", "Foundation", "-framework", "AppKit",
      "-bundle", "-undefined", "dynamic_lookup", "-Wl,-rpath,@loader_path/../../Frameworks",
      `-mmacosx-version-min=${minimumSystemVersion}`, "-arch", arch === "x64" ? "x86_64" : arch,
      source, "-o", join(staging, nativePath)]);
    await cp(join(sdk, "LICENSE"), join(staging, "Resources/updater/LICENSE.txt"));
    await writeFile(join(staging, "Resources/updater/NOTICE.txt"),
      `Pideck native updater\n\nSparkle ${sparkleVersion}: https://sparkle-project.org/\nLicense and acknowledgements: LICENSE.txt\nOfficial archive SHA-256: ${sparkleChecksum}\n\nThe application uses Sparkle's native UI, Ed25519 signature verification, installation and relaunch mechanisms.\nThe release signing private key is never included in the application.\nThe Node-API bridge was built against Electron ${electronVersion} headers, Node-API ${napiVersion}.\n`);
    await rm(sdk, { recursive: true });
    await rm(headers, { recursive: true });
    const manifest = { schema: 1, platform, arch, sparkleVersion, sparkleArchiveSha256: sparkleChecksum,
      electronVersion, electronHeadersSha256: headerChecksum, napiVersion, minimumSystemVersion,
      nativeSourceSha256: await sha256(source), framework: frameworkPath, native: nativePath,
      preparedFiles: await preparedHashes(staging) };
    await writeFile(join(staging, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
    await validateUpdaterResources(staging, { platform, arch, verifyPreparedHashes: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(`Prepared verified Sparkle ${sparkleVersion} updater for ${platform}-${arch}.`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Release tooling stays outside application resources and is never published
 * by publishUpdaterAssets. Both development and release use the same pinned
 * upstream archive; private keys are managed by the caller and Sparkle tools.
 */
export async function prepareUpdaterTools(root = projectDirectory) {
  if (process.platform !== "darwin") throw new Error("Sparkle release tools require a macOS builder.");
  const cache = resolve(root, "release/updater-downloads");
  const toolsRoot = resolve(root, "release/updater-tools");
  await mkdir(cache, { recursive: true });
  await mkdir(toolsRoot, { recursive: true });
  const sdkArchive = await archive(cache, `Sparkle-${sparkleVersion}.tar.xz`,
    `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-${sparkleVersion}.tar.xz`, sparkleChecksum);
  const staging = await mkdtemp(join(toolsRoot, `.${sparkleVersion}-`));
  const destination = join(toolsRoot, sparkleVersion);
  const names = ["sign_update", "generate_appcast", "generate_keys"];
  try {
    await run("/usr/bin/tar", ["-xf", sdkArchive, "-C", staging, "./LICENSE", ...names.map(name => `./bin/${name}`)]);
    for (const name of names) {
      const path = join(staging, "bin", name);
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || !(info.mode & 0o111)) throw new Error(`Sparkle release tool is unavailable: ${name}`);
      await run("/usr/bin/lipo", [path, "-verify_arch", process.arch === "x64" ? "x86_64" : process.arch]);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return { signUpdate: join(destination, "bin/sign_update"), generateAppcast: join(destination, "bin/generate_appcast"),
      generateKeys: join(destination, "bin/generate_keys") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function publishUpdaterAssets(context) {
  const platform = context.packager.platform.nodeName;
  if (platform !== "darwin") return undefined;
  const arch = Arch[context.arch];
  const source = join(context.packager.projectDir, "release/updater-assets", `mac-${arch}`);
  const manifest = await validateUpdaterResources(source, { platform, arch, verifyPreparedHashes: true });
  if (manifest.nativeSourceSha256 !== await sha256(join(context.packager.projectDir, "native/updater.mm"))) {
    throw new Error("Native updater bridge source changed after its assets were prepared.");
  }
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const contents = dirname(resources);
  await mkdir(join(contents, "Frameworks"), { recursive: true });
  await mkdir(join(resources, "native"), { recursive: true });
  await rm(join(contents, frameworkPath), { recursive: true, force: true });
  await cp(join(source, frameworkPath), join(contents, frameworkPath), { recursive: true, verbatimSymlinks: true });
  await cp(join(source, nativePath), join(contents, nativePath));
  await rm(join(resources, "updater"), { recursive: true, force: true });
  await cp(join(source, "Resources/updater"), join(resources, "updater"), { recursive: true, verbatimSymlinks: true });
  // Validate only our own resource tree before the enclosing application is
  // signed; other native modules/resources have separate preparation owners.
  await validateUpdaterResources(contents, { platform, arch });
  console.log(`Published verified Sparkle updater into ${context.appOutDir}.`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareUpdaterAssets();
}
