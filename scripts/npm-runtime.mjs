import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { x as extractTar } from "tar";
import { prepareInstalledLicenses } from "./licenses.mjs";

export const npmVersion = "12.2.2";
// https://registry.npmjs.org/npm/12.2.2 dist.integrity. Verify before extraction.
const npmIntegrity = "sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function integrity(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha512-${hash.digest("base64")}`;
}

async function archive(cache) {
  const file = join(cache, `npm-${npmVersion}.tgz`);
  try { await access(file); }
  catch {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(`https://registry.npmjs.org/npm/-/npm-${npmVersion}.tgz`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`npm download returned HTTP ${response.status}.`);
      const hash = createHash("sha512");
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      }), createWriteStream(temporary, { flags: "wx" }));
      if (`sha512-${hash.digest("base64")}` !== npmIntegrity) throw new Error("npm archive does not match the pinned upstream integrity.");
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await integrity(file) !== npmIntegrity) throw new Error("Cached npm archive does not match the pinned upstream integrity.");
  return file;
}

function ci(bootstrap, directory, cache, platform, arch) {
  // The bootstrap is separate: npm ci deletes its target node_modules, so it
  // must not run from the dependency tree it is replacing.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^npm_config_/i.test(name) && name !== "NODE_OPTIONS" && name !== "NODE_PATH"));
  const args = [join(bootstrap, "bin", "npm-cli.js"), "ci", "--ignore-scripts", "--omit=dev", "--include=optional",
    "--no-audit", "--no-fund", "--workspaces=false", "--registry=https://registry.npmjs.org",
    `--userconfig=${join(bootstrap, "user.npmrc")}`, `--globalconfig=${join(bootstrap, "global.npmrc")}`,
    `--cache=${join(cache, "npm-content")}`, `--os=${platform}`, `--cpu=${arch}`];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, env, stdio: "inherit", windowsHide: true, timeout: 180_000 });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`npm runtime dependency installation failed (${signal ?? code}).`)));
  });
}

export async function prepareNpmRuntime(nodeDirectory, cacheDirectory, projectDirectory = projectRoot,
  platform = process.platform, arch = process.arch) {
  await mkdir(cacheDirectory, { recursive: true });
  const source = await archive(cacheDirectory);
  const temporary = await mkdtemp(join(cacheDirectory, "npm-runtime-"));
  const bootstrap = join(temporary, "bootstrap");
  const runtime = join(temporary, "runtime");
  try {
    await mkdir(bootstrap);
    await extractTar({ file: source, cwd: bootstrap, strip: 1, strict: true });
    const upstream = JSON.parse(await readFile(join(bootstrap, "package.json"), "utf8"));
    const metadata = join(projectDirectory, "resources", "npm-runtime");
    const patched = JSON.parse(await readFile(join(metadata, "package.json"), "utf8"));
    if (upstream.version !== npmVersion || patched.name !== "npm" || patched.version !== npmVersion
      || patched.license !== upstream.license) throw new Error("npm runtime metadata does not match the pinned upstream release.");
    await cp(bootstrap, runtime, { recursive: true, verbatimSymlinks: true,
      filter: path => path !== join(bootstrap, "node_modules") });
    await Promise.all(["package.json", "package-lock.json"].map(name => cp(join(metadata, name), join(runtime, name))));
    await Promise.all(["user.npmrc", "global.npmrc"].map(name => writeFile(join(bootstrap, name), "")));
    await ci(bootstrap, runtime, cacheDirectory, platform, arch);
    await cp(join(metadata, "README.md"), join(runtime, "PIDECK-DISTRIBUTION.txt"));
    await prepareInstalledLicenses(runtime, projectDirectory);
    const destination = platform === "win32" ? join(nodeDirectory, "node_modules", "npm") : join(nodeDirectory, "lib", "node_modules", "npm");
    await rm(destination, { recursive: true, force: true });
    await cp(runtime, destination, { recursive: true, verbatimSymlinks: true });
    if (platform === "win32") {
      await Promise.all(["npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1"].map(name =>
        cp(join(destination, "bin", name), join(nodeDirectory, name))));
    }
    return { version: npmVersion, directory: destination };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
