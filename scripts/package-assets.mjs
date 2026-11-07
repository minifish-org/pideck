import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Arch } from "builder-util";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const electronVersion = "45.2.3";
const npmVersion = "10.9.9";
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
const targetNames = { darwin: "mac", linux: "linux", win32: "win" };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    let output = "";
    child.stdout?.on("data", data => { output += data; });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0
      ? resolve(output)
      : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
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
  if (manifest.schema !== 2 || manifest.runtime !== "electron" || manifest.electronVersion !== electronVersion
    || manifest.npmVersion !== npmVersion || !supportedTargets.has(`${manifest.platform}-${manifest.arch}`)
    || (expected.platform && manifest.platform !== expected.platform)
    || (expected.arch && manifest.arch !== expected.arch)) {
    throw new Error("Published automation manifest does not match the package target or pinned Electron runtime.");
  }
  if (await stat(join(root, "node")).catch(() => undefined)) throw new Error("An independent Node runtime must not be packaged.");
  async function requiredFile(entry) {
    if (typeof entry !== "string" || isAbsolute(entry) || !entry || entry.split(/[\\/]/).includes("..")) {
      throw new Error("Published automation manifest contains an invalid resource path.");
    }
    const path = join(root, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) throw new Error(`Published automation resource is missing or empty: ${entry}`);
  }
  const windows = manifest.platform === "win32";
  for (const entry of [manifest.npm, manifest.cli, manifest.chromium, "NOTICE.txt",
    "node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npx-cli.js", "node_modules/npm/LICENSE",
    "node_modules/@playwright/cli/playwright-cli.js", "node_modules/@playwright/cli/skillCheck.js",
    "node_modules/playwright/cli.js", "node_modules/playwright-core/lib/coreBundle.js",
    "node_modules/playwright-core/lib/utilsBundle.js", "node_modules/playwright-core/lib/entry/cliDaemon.js",
    "node_modules/playwright-core/lib/tools/cli-client/program.js"]) await requiredFile(entry);
  const packages = {};
  const npm = JSON.parse(await readFile(join(root, "node_modules", "npm", "package.json"), "utf8"));
  if (npm.version !== npmVersion) throw new Error("Published npm does not match the pinned version.");
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
  const ffmpeg = browsers.find(browser => browser.name === "ffmpeg");
  const ffmpegDirectory = `browsers/ffmpeg-${ffmpeg?.revision}`;
  const ffmpegName = windows ? "ffmpeg-win64.exe" : manifest.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux";
  await requiredFile(`${ffmpegDirectory}/${ffmpegName}`);
  await requiredFile(`${ffmpegDirectory}/COPYING.LGPLv2.1`);
  await requiredFile(`${manifest.chromium.split("/").slice(0, 3).join("/")}/ABOUT`);
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
  if (!supportedTargets.has(`${platform}-${arch}`)) {
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
    const npmPackage = JSON.parse(await readFile(join(root, "node_modules", "npm", "package.json"), "utf8"));
    const cliPackage = JSON.parse(await readFile(join(root, "node_modules", "@playwright", "cli", "package.json"), "utf8"));
    const playwrightPackage = JSON.parse(await readFile(join(root, "node_modules", "playwright", "package.json"), "utf8"));
    const corePackage = JSON.parse(await readFile(join(root, "node_modules", "playwright-core", "package.json"), "utf8"));
    if (rootPackage.devDependencies.electron !== electronVersion || rootPackage.devDependencies.npm !== npmVersion
      || npmPackage.version !== npmVersion || cliPackage.version !== rootPackage.devDependencies["@playwright/cli"]
      || playwrightPackage.version !== rootPackage.devDependencies.playwright
      || cliPackage.dependencies.playwright !== playwrightPackage.version
      || cliPackage.dependencies["playwright-core"] !== corePackage.version
      || playwrightPackage.dependencies["playwright-core"] !== corePackage.version) {
      throw new Error("The installed Playwright CLI and browser installer do not match the pinned package versions; run npm ci.");
    }
    for (const name of ["@playwright/cli", "playwright", "playwright-core", "npm"]) {
      await cp(join(root, "node_modules", name), join(staging, "node_modules", name), { recursive: true, verbatimSymlinks: true });
    }

    // Use the pinned installer's download URLs, revisions and archive handling.
    // Its platform override selects the package target, not the build host.
    const browserCache = join(cache, "browsers");
    const hostPlatform = platform === "darwin" ? `mac26${arch === "arm64" ? "-arm64" : ""}`
      : platform === "linux" ? `ubuntu22.04-${arch}` : "win64";
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform, PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000", NO_UPDATE_NOTIFIER: "1" };
    await run(process.execPath, [join(root, "node_modules", "playwright", "cli.js"), "install", "chromium", "--no-shell", "--no-progress", "--no-remove"], { env, cwd: root });
    const metadata = JSON.parse(await run(process.execPath, ["-e", `
      const registry = require('playwright-core/lib/coreBundle').registry.registry;
      console.log(JSON.stringify(['chromium', 'ffmpeg'].map(name => {
        const browser = registry.findExecutable(name);
        return { name, directory: browser.directory, executable: browser.executablePath(), revision: browser.revision };
      })));
    `], { env, cwd: root, stdio: ["ignore", "pipe", "inherit"] }));
    await mkdir(join(staging, "browsers"));
    for (const browser of metadata) {
      await access(browser.executable);
      // Exclude install-cache links and host validation markers outside these
      // distribution directories; they contain build-machine paths.
      await cp(browser.directory, join(staging, "browsers", relative(browserCache, browser.directory)), { recursive: true, verbatimSymlinks: true });
    }
    const chromium = metadata.find(browser => browser.name === "chromium");
    const manifest = { schema: 2, platform, arch, runtime: "electron", electronVersion, npmVersion, cliVersion: cliPackage.version,
      playwrightVersion: playwrightPackage.version, browserRevision: chromium.revision,
      npm: "node_modules/npm/bin/npm-cli.js",
      cli: "node_modules/@playwright/cli/playwright-cli.js",
      chromium: `browsers/${relative(browserCache, chromium.executable).split("\\").join("/")}` };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(staging, "NOTICE.txt"), `Pideck browser automation\n\nThe Node runtime is reused from Electron ${electronVersion}; no independent Node distribution is included.\nnpm ${npmVersion}: node_modules/npm/LICENSE and its bundled dependency notices.\nPlaywright CLI ${cliPackage.version}, Playwright ${playwrightPackage.version}: LICENSE and NOTICE files in node_modules/@playwright/cli, node_modules/playwright and node_modules/playwright-core.\nChromium ${chromium.revision} and FFmpeg: upstream distribution license/credit files under browsers/.\n`);
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
