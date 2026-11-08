import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import ts from "typescript";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const noticeName = /(?:^|[._-])(?:licen[cs]es?|copying|copyright|notices?|third[-_]?party(?:notices?)?)(?:$|[._-])/i;
const packageName = value => value.startsWith("@") ? value.split("/").slice(0, 2).join("/") : value.split("/")[0];

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
const hash = value => createHash("sha256").update(value).digest("hex");

async function optionalJson(path) {
  try { return await json(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
}

async function resolvePackage(name, from, root) {
  for (let current = from; ; current = dirname(current)) {
    const directory = join(current, "node_modules", name);
    if (await optionalJson(join(directory, "package.json"))) return realpath(directory);
    if (current === root || dirname(current) === current) return;
  }
}

async function rendererImports(root) {
  const names = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        const imports = ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName);
        for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) imports.push(match[1]);
        for (const value of imports) if (!value.startsWith(".") && !value.startsWith("/") && !value.startsWith("node:")) names.add(packageName(value));
      }
    }
  }
  await visit(join(root, "src", "renderer"));
  return names;
}

async function licenseTexts(directory) {
  const texts = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && noticeName.test(entry.name)) texts.push({ file: relative(directory, path).split("\\").join("/"), text: await readFile(path, "utf8") });
    }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === installedNotices) continue;
    if (!noticeName.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile()) texts.push({ file: entry.name, text: await readFile(path, "utf8") });
  }
  if (!texts.some(value => /licen[cs]e|copying|copyright/i.test(value.file))) {
    for (const name of ["README.md", "readme.md", "README"]) {
      const text = await readFile(join(directory, name), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; });
      const start = text?.search(/(?:^|\n)(?:#{1,6}\s*(?:MIT\s+)?licen[cs]e\b|licen[cs]e\s*\n[-=])/i) ?? -1;
      const section = start >= 0 ? text.slice(start).trim() : "";
      if (section.includes("Permission is hereby granted") && section.includes("THE SOFTWARE IS PROVIDED") && /Copyright/i.test(section)) {
        texts.push({ file: `${name} (license section)`, text: section });
        break;
      }
    }
  }
  return texts.filter(value => value.text.trim()).sort((a, b) => a.file.localeCompare(b.file, "en"));
}

async function supplementedTexts(root, directory, pkg, supplements) {
  const texts = await licenseTexts(directory);
  const supplement = supplements[`${pkg.name}@${pkg.version}`];
  if (!supplement) return texts;
  if (supplement.license !== pkg.license) throw new Error(`The upstream license supplement no longer matches ${pkg.name}@${pkg.version}.`);
  const text = await readFile(join(root, "licenses", supplement.file), "utf8");
  if (!/^[a-f0-9]{64}$/.test(supplement.sha256) || hash(text) !== supplement.sha256) {
    throw new Error(`The upstream license supplement hash no longer matches ${pkg.name}@${pkg.version}.`);
  }
  texts.unshift({ file: "upstream/LICENSE", text, source: supplement.source });
  if (supplement.attribution) texts.push({ file: "upstream/attribution.txt", text: supplement.attribution, source: supplement.declaration });
  if (supplement.readmeAttribution) {
    const readme = await readFile(join(directory, "README.md"), "utf8");
    const start = readme.search(/(?:^|\n)#{1,6}\s*(?:Copyright and Licensing|License)\b/i);
    if (start < 0) throw new Error(`The upstream README attribution is missing for ${pkg.name}@${pkg.version}.`);
    texts.push({ file: "README.md (upstream attribution)", text: readme.slice(start).trim() });
  }
  return texts;
}

export async function collectLicenses(root = projectDirectory) {
  root = await realpath(root);
  const application = await json(join(root, "package.json"));
  const supplements = await optionalJson(join(root, "licenses", "supplements.json")) ?? {};
  const entries = new Map();
  const missing = [];
  async function visit(name, from, optional = false) {
    const directory = await resolvePackage(name, from, root);
    if (!directory) { if (optional) return; throw new Error(`A distributed dependency is not installed: ${name}`); }
    if (entries.has(directory)) return;
    const pkg = await json(join(directory, "package.json"));
    const texts = await supplementedTexts(root, directory, pkg, supplements);
    if (pkg.name.startsWith("@esbuild/") && pkg.license === "MIT") {
      const sourceDirectory = await resolvePackage("esbuild", directory, root);
      const sourcePackage = sourceDirectory && await json(join(sourceDirectory, "package.json"));
      if (sourcePackage?.version === pkg.version) texts.unshift({ file: "upstream/esbuild/LICENSE", text: await readFile(join(sourceDirectory, "LICENSE.md"), "utf8"),
        source: `https://github.com/evanw/esbuild/blob/v${pkg.version}/LICENSE.md` });
    }
    if (!texts.some(value => /licen[cs]e|copying|copyright/i.test(value.file))) {
      missing.push(`${pkg.name}@${pkg.version}`);
    }
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    entries.set(directory, { name: pkg.name, version: pkg.version, license: pkg.license ?? "SEE LICENSE", repository, texts });
    const optionalNames = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      await visit(dependency, directory, optionalNames.has(dependency));
    }
    // Installed peers may be shipped (for example React); absent optional peers
    // such as other framework adapters are not added to the distribution.
    for (const dependency of Object.keys(pkg.peerDependencies ?? {})) await visit(dependency, directory, true);
  }
  for (const name of new Set([...Object.keys(application.dependencies ?? {}), ...await rendererImports(root)])) await visit(name, root);
  if (missing.length) throw new Error(`Missing distributed license text for ${missing.join(", ")}. Add version-specific upstream licenses before packaging.`);
  return [...entries.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
}

// Enumerate package roots in the physical installed tree, including nested
// copies. package.json files inside dist/esm or dist/commonjs are not packages.
async function installedPackages(directory) {
  const packages = [];
  async function visit(path) {
    const pkg = await json(join(path, "package.json"));
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error(`Invalid installed package metadata: ${path}`);
    packages.push({ directory: path, pkg, path: relative(directory, path).split("\\").join("/") || "." });
    const modules = join(path, "node_modules");
    const entries = await readdir(modules, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const child = join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) await visit(join(child, scoped.name));
        }
      } else await visit(child);
    }
  }
  await visit(directory);
  return packages.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

const installedNotices = "PIDECK-THIRD-PARTY-NOTICES.txt";
const installedInventory = "PIDECK-DEPENDENCIES.json";

export async function prepareInstalledLicenses(directory, root = projectDirectory) {
  const supplements = await optionalJson(join(root, "licenses", "supplements.json")) ?? {};
  const sections = ["Pideck bundled npm runtime third-party notices", "",
    "Complete license texts and upstream attribution for the actual installed npm tree.",
    "Version-specific supplements are identified by their recorded source; package metadata alone is not treated as license text."];
  const dependencies = [];
  for (const entry of await installedPackages(directory)) {
    const { pkg, path } = entry;
    const texts = await supplementedTexts(root, entry.directory, pkg, supplements);
    if (!texts.some(value => /licen[cs]e|copying|copyright/i.test(value.file))) {
      throw new Error(`Missing distributed license text for ${pkg.name}@${pkg.version} in the installed npm tree.`);
    }
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    sections.push("", "=".repeat(72), `${pkg.name}@${pkg.version}`, `Installed path: ${path}`, `Declared license: ${pkg.license ?? "SEE LICENSE"}`);
    if (repository) sections.push(`Upstream: ${repository}`);
    for (const text of texts) sections.push("", `--- ${text.file}${text.source ? ` (${text.source})` : ""} ---`, text.text.trim());
    dependencies.push({ path, name: pkg.name, version: pkg.version, license: pkg.license ?? "SEE LICENSE", repository,
      notices: texts.map(({ file, source, text }) => ({ file, ...(source ? { source } : {}), sha256: hash(text) })) });
  }
  const notices = `${sections.join("\n")}\n`;
  const manifest = { schema: 1, hashes: { notices: hash(notices) }, dependencies };
  await writeFile(join(directory, installedNotices), notices);
  await writeFile(join(directory, installedInventory), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateInstalledLicenses(directory);
  return manifest;
}

export async function validateInstalledLicenses(directory) {
  const manifest = await json(join(directory, installedInventory));
  const notices = await readFile(join(directory, installedNotices), "utf8");
  if (manifest.schema !== 1 || !Array.isArray(manifest.dependencies) || !manifest.dependencies.length
    || hash(notices) !== manifest.hashes?.notices) throw new Error("The installed npm license inventory or notice hash is invalid.");
  const actual = await installedPackages(directory);
  const recorded = new Map(manifest.dependencies.map(entry => [entry.path, entry]));
  if (recorded.size !== actual.length || recorded.size !== manifest.dependencies.length) {
    throw new Error("The installed npm package tree no longer matches its license inventory.");
  }
  for (const { pkg, path } of actual) {
    const entry = recorded.get(path);
    if (!entry || entry.name !== pkg.name || entry.version !== pkg.version || entry.license !== (pkg.license ?? "SEE LICENSE")
      || !entry.notices?.length || !notices.includes(`${pkg.name}@${pkg.version}`)) {
      throw new Error(`The installed npm license inventory does not cover ${pkg.name}@${pkg.version}.`);
    }
  }
  return manifest;
}

export async function prepareLicenses(root = projectDirectory, destination = join(root, "dist", "licenses")) {
  const application = await json(join(root, "package.json"));
  const entries = await collectLicenses(root);
  const sections = ["Pideck third-party notices", "", "License and copyright texts for the application's runtime dependencies and the dependency closure of renderer imports.",
    "Node.js/npm and Playwright retain additional notices in the automation resources.",
    "Browser and media binaries are not distributed in Pideck. The upstream Playwright installer downloads them directly to application data on first browser use."];
  for (const entry of entries) {
    sections.push("", "=".repeat(72), `${entry.name}@${entry.version}`, `Declared license: ${entry.license}`);
    if (entry.repository) sections.push(`Upstream: ${entry.repository}`);
    for (const license of entry.texts) sections.push("", `--- ${license.file}${license.source ? ` (${license.source})` : ""} ---`, license.text.trim());
  }
  await mkdir(destination, { recursive: true });
  const ownLicense = await readFile(join(root, "LICENSE"));
  const notices = `${sections.join("\n")}\n`;
  await writeFile(join(destination, "Pideck-LICENSE.txt"), ownLicense);
  await writeFile(join(destination, "THIRD_PARTY_NOTICES.txt"), notices);
  const manifest = { schema: 1, application: { name: application.name, version: application.version, license: application.license,
    source: "https://github.com/minifish-org/pideck" }, hashes: { license: hash(ownLicense), notices: hash(notices) },
    dependencies: entries.map(({ texts, ...entry }) => ({ ...entry, notices: texts.map(({ file, source }) => ({ file, ...(source ? { source } : {}) })) })) };
  await writeFile(join(destination, "dependencies.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateLicenses(destination);
  return manifest;
}

export async function validateLicenses(directory) {
  return validateLicenseContents(name => readFile(join(directory, name), "utf8"));
}

export async function validatePackagedLicenses(archive) {
  return validateLicenseContents(async name => asar.extractFile(archive, `dist/licenses/${name}`).toString("utf8"));
}

async function validateLicenseContents(read) {
  const manifest = JSON.parse(await read("dependencies.json"));
  if (manifest.schema !== 1 || !manifest.application?.license || !manifest.dependencies?.length) throw new Error("Distributed license inventory is missing or invalid.");
  const ownLicense = await read("Pideck-LICENSE.txt");
  if (!ownLicense.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) throw new Error("Pideck's AGPL license is missing from the package.");
  const notices = await read("THIRD_PARTY_NOTICES.txt");
  if (hash(ownLicense) !== manifest.hashes?.license || hash(notices) !== manifest.hashes?.notices) throw new Error("Distributed license texts do not match their inventory.");
  for (const dependency of manifest.dependencies) {
    if (!dependency.notices?.length || !notices.includes(`${dependency.name}@${dependency.version}`)) throw new Error(`Distributed license notice is missing for ${dependency.name}.`);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareLicenses();
