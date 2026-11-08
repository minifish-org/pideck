import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Arch } from "builder-util";
import { x as extractTar } from "tar";
import { utils } from "playwright-core/lib/coreBundle";
import { npmVersion, prepareNpmRuntime } from "./npm-runtime.mjs";
import { validateInstalledLicenses } from "./licenses.mjs";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const nodeVersion = "22.23.4";
// Official https://nodejs.org/dist/v22.23.4/SHASUMS256.txt, pinned with the runtime.
const nodeChecksums = {
  "darwin-arm64": "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428",
  "darwin-x64": "efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819",
  "linux-arm64": "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
  "linux-x64": "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
  "win32-x64": "cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20",
};
const targetNames = { darwin: "mac", linux: "linux", win32: "win" };

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function nodeArchive(cache, platform, arch) {
  const target = `${platform}-${arch}`;
  const checksum = nodeChecksums[target];
  const archive = `node-v${nodeVersion}-${platform === "win32" ? "win" : platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const path = join(cache, archive);
  try {
    await access(path);
  } catch {
    const temporary = `${path}.${randomUUID()}.tmp`;
    console.log(`Preparing automation: downloading official Node.js ${nodeVersion} (${target}).`);
    try {
      const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archive}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Node.js download returned HTTP ${response.status}.`);
      const hash = createHash("sha256");
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      }), createWriteStream(temporary, { flags: "wx" }));
      if (hash.digest("hex") !== checksum) throw new Error(`Node.js ${target} archive checksum does not match the pinned release.`);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (await sha256(path) !== checksum) throw new Error(`Cached Node.js ${target} archive checksum does not match the pinned release.`);
  return path;
}

export async function validateAutomationLinks(root) {
  const base = await realpath(root);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        // Absolute links are not portable even when they currently point back
        // into this tree. Never publish build-cache or staging-directory paths.
        if (isAbsolute(link)) throw new Error(`Automation resource link ${relative(base, path)} must be relative.`);
        const target = await realpath(path);
        const location = relative(base, target);
        if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
          throw new Error(`Automation resource link ${relative(base, path)} escapes its resource tree.`);
        }
      } else if (entry.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(base);
}

export async function validateAutomationResources(root, expected = {}) {
  await validateAutomationLinks(root);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.schema !== 2 || !Object.hasOwn(nodeChecksums, `${manifest.platform}-${manifest.arch}`)
    || manifest.nodeVersion !== nodeVersion
    || manifest.npmVersion !== npmVersion
    || (expected.platform && manifest.platform !== expected.platform)
    || (expected.arch && manifest.arch !== expected.arch)) {
    throw new Error("Published automation manifest does not match the package target or pinned Node.js version.");
  }
  async function requiredFile(entry) {
    if (typeof entry !== "string" || isAbsolute(entry) || !entry || entry.split(/[\\/]/).includes("..")) {
      throw new Error("Published automation manifest contains an invalid resource path.");
    }
    const path = join(root, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) throw new Error(`Published automation resource is missing or empty: ${entry}`);
  }
  const windows = manifest.platform === "win32";
  const npm = windows ? "node/node_modules/npm" : "node/lib/node_modules/npm";
  for (const entry of [manifest.node, manifest.cli, manifest.playwright, "node/LICENSE", "NOTICE.txt",
    `${npm}/bin/npm-cli.js`, `${npm}/bin/npx-cli.js`,
    windows ? "node/npm.cmd" : "node/bin/npm", windows ? "node/npx.cmd" : "node/bin/npx",
    `${npm}/package.json`, `${npm}/LICENSE`, `${npm}/PIDECK-DISTRIBUTION.txt`,
    "node_modules/@playwright/cli/playwright-cli.js", "node_modules/@playwright/cli/skillCheck.js",
    "node_modules/playwright/cli.js", "node_modules/playwright-core/lib/coreBundle.js",
    "node_modules/playwright-core/lib/utilsBundle.js", "node_modules/playwright-core/lib/entry/cliDaemon.js",
    "node_modules/playwright-core/lib/tools/cli-client/program.js"]) await requiredFile(entry);
  const bundledNpm = JSON.parse(await readFile(join(root, npm, "package.json"), "utf8"));
  if (bundledNpm.version !== npmVersion) throw new Error("Published npm does not match its pinned version.");
  await validateInstalledLicenses(join(root, npm));
  // Browser executables are obtained directly from their upstream distributor
  // on first use. An old staging tree must never reintroduce them into a release.
  if (await access(join(root, "browsers")).then(() => true, () => false)) {
    throw new Error("Browser and FFmpeg binaries must not be redistributed in Pideck resources.");
  }
  const packages = {};
  for (const name of ["@playwright/cli", "playwright", "playwright-core"]) {
    await requiredFile(`node_modules/${name}/LICENSE`);
    await requiredFile(`node_modules/${name}/package.json`);
    packages[name] = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    if (name !== "@playwright/cli") {
      await requiredFile(`node_modules/${name}/NOTICE`);
      await requiredFile(`node_modules/${name}/ThirdPartyNotices.txt`);
    }
  }
  if (packages["@playwright/cli"].version !== manifest.cliVersion
    || packages.playwright.version !== manifest.playwrightVersion
    || packages["playwright-core"].version !== manifest.playwrightVersion
    || packages["@playwright/cli"].dependencies.playwright !== manifest.playwrightVersion
    || packages["@playwright/cli"].dependencies["playwright-core"] !== manifest.playwrightVersion) {
    throw new Error("Published automation CLI dependencies do not match its manifest.");
  }
  const browsers = JSON.parse(await readFile(join(root, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers;
  if (browsers.find(browser => browser.name === "chromium")?.revision !== manifest.browserRevision) {
    throw new Error("Published Chromium revision does not match the Playwright installation.");
  }
  return manifest;
}

export async function publishAutomation(context) {
  const platform = context.packager.platform.nodeName;
  const arch = Arch[context.arch];
  const source = join(context.packager.projectDir, "release", "automation-assets", `${targetNames[platform]}-${arch}`);
  const destination = join(context.packager.getResourcesDir(context.appOutDir), "automation");
  await validateAutomationResources(source, { platform, arch });
  await rm(destination, { recursive: true, force: true });
  // electron-builder's normal resource filter drops a top-level node_modules.
  // Publish the upstream distribution unchanged, after filtering and before signing.
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  await validateAutomationResources(destination, { platform, arch });
  console.log(`Verified published automation resources: ${destination}`);
}

export async function prepareAutomation(platform = process.platform, arch = process.arch, root = projectDirectory) {
  if (!Object.hasOwn(nodeChecksums, `${platform}-${arch}`)) {
    throw new Error(`Bundled browser automation does not support ${platform}-${arch}; use macOS/Linux x64 or arm64, or Windows x64.`);
  }
  const os = targetNames[platform];
  const assetRoot = join(root, "release", "automation-assets");
  const cache = join(root, "release", "automation-downloads", `${os}-${arch}`);
  await mkdir(assetRoot, { recursive: true });
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(assetRoot, `.${os}-${arch}-`));
  const destination = join(assetRoot, `${os}-${arch}`);
  try {
    const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const cliPackage = JSON.parse(await readFile(join(root, "node_modules", "@playwright", "cli", "package.json"), "utf8"));
    const playwrightPackage = JSON.parse(await readFile(join(root, "node_modules", "playwright", "package.json"), "utf8"));
    const corePackage = JSON.parse(await readFile(join(root, "node_modules", "playwright-core", "package.json"), "utf8"));
    if (cliPackage.version !== rootPackage.devDependencies["@playwright/cli"]
      || playwrightPackage.version !== rootPackage.devDependencies.playwright
      || cliPackage.dependencies.playwright !== playwrightPackage.version
      || cliPackage.dependencies["playwright-core"] !== corePackage.version
      || playwrightPackage.dependencies["playwright-core"] !== corePackage.version) {
      throw new Error("The installed Playwright CLI and browser installer do not match the pinned package versions; run npm ci.");
    }
    const archive = await nodeArchive(cache, platform, arch);
    if (platform === "win32") {
      const unpacked = join(staging, ".node-unpack");
      await utils.extractZip(archive, { dir: unpacked });
      await rename(join(unpacked, `node-v${nodeVersion}-win-${arch}`), join(staging, "node"));
      await rm(unpacked, { recursive: true });
    } else {
      await mkdir(join(staging, "node"));
      await extractTar({ file: archive, cwd: join(staging, "node"), strip: 1, strict: true });
    }
    await prepareNpmRuntime(join(staging, "node"), cache, root, platform);
    for (const name of ["@playwright/cli", "playwright", "playwright-core"]) {
      await cp(join(root, "node_modules", name), join(staging, "node_modules", name), { recursive: true, verbatimSymlinks: true });
    }

    const browsers = JSON.parse(await readFile(join(staging, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers;
    const chromium = browsers.find(browser => browser.name === "chromium");
    const manifest = { schema: 2, platform, arch, nodeVersion, npmVersion, cliVersion: cliPackage.version,
      playwrightVersion: playwrightPackage.version, browserRevision: chromium.revision,
      node: platform === "win32" ? "node/node.exe" : "node/bin/node",
      cli: "node_modules/@playwright/cli/playwright-cli.js",
      playwright: "node_modules/playwright/cli.js" };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(staging, "NOTICE.txt"), `Pideck browser automation\n\nNode.js ${nodeVersion}: node/LICENSE. npm ${npmVersion}: licenses in its distribution and pinned runtime dependencies.\nPlaywright CLI ${cliPackage.version}, Playwright ${playwrightPackage.version}: LICENSE and NOTICE files in node_modules/@playwright/cli, node_modules/playwright and node_modules/playwright-core.\nBrowser revision ${chromium.revision} and FFmpeg are NOT included in this package. On first browser use, the pinned upstream Playwright installer obtains them directly from upstream into application data. Their upstream licenses and terms apply. See https://github.com/minifish-org/pideck/blob/main/docs/BROWSER_DISTRIBUTION.md.\n`);
    await validateAutomationResources(staging, { platform, arch });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(`Prepared bundled automation for ${platform}-${arch}: ${destination}`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export default async function beforePack(context) {
  if (context.packager.info.options.targets?.get(context.packager.platform)?.has(Arch.universal)) {
    throw new Error("Bundled browser automation requires a separate macOS x64 or arm64 package; universal packages are not supported.");
  }
  await prepareAutomation(context.packager.platform.nodeName, Arch[context.arch], context.packager.projectDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAutomation();
}
