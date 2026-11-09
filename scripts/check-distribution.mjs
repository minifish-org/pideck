import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import semver from "semver";
import { validateAutomationResources } from "./package-assets.mjs";
import { validatePackagedLicenses } from "./licenses.mjs";
import { validateUpdaterResources } from "./update-assets.mjs";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const advisoryEndpoint = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const moduleManifest = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/;

function defaultApplication() {
  if (process.platform === "darwin") return join(projectDirectory, "release", `mac-${process.arch}`, "Pideck.app");
  const directory = process.platform === "win32" ? "win-unpacked" : process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`;
  return join(projectDirectory, "release", directory);
}

async function resourcesDirectory(input) {
  const path = resolve(input);
  const candidates = [path, join(path, "Contents", "Resources"), join(path, "resources")];
  for (const candidate of candidates) {
    if ((await stat(join(candidate, "app.asar")).catch(error => { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }))?.isFile()) return candidate;
  }
  throw new Error("The supplied application has no app.asar in its resources. Only a packaged application is checked; user data is never scanned.");
}

export function distributionPathIssues(entries) {
  const issues = [];
  for (const { path: original, directory = false } of entries) {
    const path = original.replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = path.split("/");
    const name = parts.at(-1);
    if (parts.some(part => part === ".git" || part === ".ssh" || part === ".aws" || part === ".npm" || part === ".playwright-cli")) {
      issues.push({ path, reason: "Repository, credential or runtime cache directory must not be distributed." });
    } else if (/^\.env(?:\.|$)/i.test(name) || (!directory && (
      /^\.(?:npmrc|netrc)$/i.test(name)
      || /^(?:provider-credentials(?:\.tmp)?|provider-keys\.json|credentials\.json|auth\.json|id_rsa|id_ed25519|Cookies|History|Local State|Login Data|Web Data|Preferences|Secure Preferences|DevToolsActivePort)$/i.test(name)
      || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$|\.(?:p12|pfx|key|pem)$/i.test(name)))) {
      issues.push({ path, reason: "Potential credential, private certificate, database or browser user-data file." });
    } else if (!parts.includes("node_modules") && parts.some(part => /^(?:user-data|userData|browser-data|browser-cache|browser-profiles|profiles?|Profile \d+|conversations|tool-output)$/i.test(part))) {
      issues.push({ path, reason: "Application or browser user-data directory must not be distributed." });
    }
    if (/(?:^|\/)automation\/browsers(?:\/|$)/i.test(path)
      || parts.some(part => /^Google Chrome(?: for Testing)?\.app$|^chrome-(?:mac|linux|win)(?:-|$)/i.test(part))
      || (!directory && /^(?:ffmpeg(?:-(?:mac|linux|win64))?|chrome|chromium)(?:\.exe|\.zip|\.tar\.(?:gz|xz))?$/i.test(name))) {
      issues.push({ path, reason: "Browser and FFmpeg binaries must be downloaded directly from upstream, not redistributed in Pideck." });
    }
  }
  return issues;
}

async function filesUnder(root) {
  const entries = [];
  async function walk(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      // Never follow a link into a build cache or another directory. The
      // automation validator separately verifies its portable relative links.
      entries.push({ path, directory: item.isDirectory(), file: item.isFile() });
      if (item.isDirectory()) await walk(join(directory, item.name), path);
    }
  }
  await walk(root);
  return entries;
}

function packageRecord(contents, path) {
  const pkg = JSON.parse(contents);
  if (typeof pkg.name !== "string" || !semver.valid(pkg.version)) throw new Error(`Invalid distributed npm package metadata: ${path}`);
  return { name: pkg.name, version: pkg.version, path };
}

export async function auditPackageVersions(packages, fetcher = fetch) {
  const unique = new Map();
  for (const pkg of packages) {
    if (typeof pkg.name !== "string" || !semver.valid(pkg.version)) throw new Error("Cannot audit a package with an invalid name or version.");
    if (!unique.has(pkg.name)) unique.set(pkg.name, new Set());
    unique.get(pkg.name).add(pkg.version);
  }
  if (!unique.size) throw new Error("No distributed npm packages were found; an empty audit cannot pass.");
  let response;
  try {
    response = await fetcher(advisoryEndpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries([...unique].map(([name, versions]) => [name, [...versions].sort()]))), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("The npm advisory service could not be reached. Distribution security was not verified.");
  }
  if (!response.ok) throw new Error(`The npm advisory service returned HTTP ${response.status}. Distribution security was not verified.`);
  let advisories;
  try { advisories = await response.json(); }
  catch { throw new Error("The npm advisory service returned invalid JSON. Distribution security was not verified."); }
  if (!advisories || typeof advisories !== "object" || Array.isArray(advisories) || advisories.error) {
    throw new Error("The npm advisory service returned an invalid response. Distribution security was not verified.");
  }
  const findings = [];
  for (const [name, values] of Object.entries(advisories)) {
    if (!Array.isArray(values)) throw new Error("The npm advisory service returned invalid advisory records.");
    for (const advisory of values) {
      if (typeof advisory.vulnerable_versions !== "string" || !semver.validRange(advisory.vulnerable_versions)
        || typeof advisory.url !== "string" || typeof advisory.severity !== "string") throw new Error("The npm advisory service returned an incomplete advisory.");
      const installed = packages.filter(pkg => pkg.name === name && semver.satisfies(pkg.version, advisory.vulnerable_versions, { includePrerelease: true }));
      if (installed.length) findings.push({ package: name, severity: advisory.severity, title: advisory.title, url: advisory.url,
        range: advisory.vulnerable_versions, installed: installed.map(({ version, path }) => ({ version, path })) });
    }
  }
  return { packageRecords: packages.length, uniquePackages: unique.size,
    uniquePackageVersions: [...unique.values()].reduce((count, versions) => count + versions.size, 0), findings };
}

export async function checkDistribution(input = defaultApplication(), options = {}) {
  const report = { schema: 1, checkedAt: new Date().toISOString(), status: "failed", scope: "Physically distributed modules and compiled dependency versions from the packaged license inventory; advisory matches are not a claim of exploitability.", checks: {}, errors: [], pathIssues: [], packages: [], advisories: null };
  try {
    const resources = await resourcesDirectory(input);
    const archive = join(resources, "app.asar");
    const asarEntries = asar.listPackage(archive).map(path => {
      path = path.replace(/^\/+/, "");
      const entry = asar.statFile(archive, path);
      return { path, directory: Boolean(entry.files), file: !entry.files && !entry.link };
    });
    const rootLicense = asar.extractFile(archive, "LICENSE").toString("utf8");
    if (!rootLicense.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) throw new Error("The application-root AGPL LICENSE is missing or invalid.");
    if (rootLicense !== asar.extractFile(archive, "dist/licenses/Pideck-LICENSE.txt").toString("utf8")) throw new Error("The application-root LICENSE differs from its distributed AGPL license.");
    const licenseInventory = await validatePackagedLicenses(archive);
    report.checks.licenses = licenseInventory.dependencies.length;
    const packagedManifest = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
    if (resources.endsWith(`${process.platform === "win32" ? "\\" : "/"}Contents${process.platform === "win32" ? "\\" : "/"}Resources`)
      && semver.gte(packagedManifest.version, "0.1.2")) {
      report.checks.updater = await validateUpdaterResources(dirname(resources));
    }
    report.checks.automation = await validateAutomationResources(join(resources, "automation"));
    const resourceEntries = await filesUnder(resources);
    report.pathIssues = distributionPathIssues([
      ...asarEntries.map(entry => ({ ...entry, path: `app.asar/${entry.path}` })),
      ...resourceEntries,
    ]);
    for (const entry of asarEntries) {
      if (entry.file && entry.path.startsWith("node_modules/") && moduleManifest.test(entry.path)) {
        report.packages.push(packageRecord(asar.extractFile(archive, entry.path).toString("utf8"), `app.asar/${entry.path}`));
      }
    }
    for (const entry of resourceEntries) {
      if (!entry.file || !moduleManifest.test(entry.path)) continue;
      if (entry.path.startsWith("automation/node_modules/") || /^automation\/node\/(?:lib\/)?node_modules\/npm\//.test(entry.path)) {
        report.packages.push(packageRecord(await readFile(join(resources, entry.path), "utf8"), entry.path));
      }
    }
    const packageManifestFiles = report.packages.length;
    // Renderer dependencies are compiled into JS and no longer have individual
    // package.json files. Their verified license inventory retains the versions.
    for (const dependency of licenseInventory.dependencies) report.packages.push({ name: dependency.name, version: dependency.version,
      path: `app.asar/dist/licenses/dependencies.json#${dependency.name}@${dependency.version}` });
    report.checks.npm = { status: "not-verified", packageManifestFiles, bundledDependencyRecords: licenseInventory.dependencies.length,
      packageRecords: report.packages.length };
    const audit = await auditPackageVersions(report.packages, options.fetch ?? fetch);
    report.checks.npm = { ...report.checks.npm, status: "verified",
      packageRecords: audit.packageRecords, uniquePackages: audit.uniquePackages, uniquePackageVersions: audit.uniquePackageVersions };
    report.advisories = audit.findings;
    if (report.pathIssues.length) report.errors.push(`${report.pathIssues.length} prohibited or potentially sensitive paths were found.`);
    if (report.advisories.length) report.errors.push(`${report.advisories.length} known npm advisory matches were found in the actual package.`);
    if (!report.errors.length) report.status = "passed";
  } catch (error) { report.errors.push(error instanceof Error ? error.message : "Distribution verification failed."); }
  if (options.report) {
    await mkdir(dirname(resolve(options.report)), { recursive: true });
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let input;
  let report;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--report") { report = args[++index]; if (!report) throw new Error("--report requires a JSON destination."); }
    else if (arg.startsWith("--report=")) { report = arg.slice("--report=".length); if (!report) throw new Error("--report requires a JSON destination."); }
    else if (arg.startsWith("-") || input) throw new Error("Usage: node scripts/check-distribution.mjs [application-or-resources] [--report report.json]");
    else input = arg;
  }
  const result = await checkDistribution(input, { report });
  const npm = result.checks.npm;
  console.log(`Distribution check ${result.status}: ${npm?.packageManifestFiles ?? "unverified"} package manifest files + ${npm?.bundledDependencyRecords ?? "unverified"} compiled dependency records, ${result.pathIssues.length} path issues, advisory matches: ${result.advisories === null ? "not verified" : result.advisories.length}.`);
  for (const error of result.errors) console.error(error);
  for (const issue of result.pathIssues) console.error(`${issue.path}: ${issue.reason}`);
  for (const advisory of result.advisories ?? []) console.error(`${advisory.package}@${[...new Set(advisory.installed.map(pkg => pkg.version))].join(", ")}: ${advisory.severity} — ${advisory.url}`);
  if (result.status !== "passed") process.exitCode = 1;
}
