import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import asar from '@electron/asar';

type Package = { name: string; version: string; path: string };
type Finding = { package: string; severity: string; url: string; installed: { version: string; path: string }[] };
type Report = { status: string; errors: string[]; packages: Package[]; pathIssues: unknown[]; advisories: Finding[] | null;
  checks: { npm?: { packageManifestFiles: number; bundledDependencyRecords: number; packageRecords: number; uniquePackageVersions: number } } };
const { distributionPathIssues, auditPackageVersions, checkDistribution } = await import(new URL('../scripts/check-distribution.mjs', import.meta.url).href) as {
  distributionPathIssues(entries: { path: string; directory?: boolean }[]): { path: string; reason: string }[];
  auditPackageVersions(packages: Package[], fetcher?: typeof fetch): Promise<{ findings: Finding[] }>;
  checkDistribution(input: string, options?: { fetch?: typeof fetch; report?: string }): Promise<Report>;
};

test('distribution checks distinguish saved secrets and browser state from credential-related application code', () => {
  const bad = ['app.asar/.env', 'automation/.env.local', 'app.asar/provider-credentials',
    'app.asar/dist/workspace.sqlite-wal', 'app.asar/dist/tool-output/result.txt', 'automation/browser-data/Cookies',
    'app.asar/.ssh/id_ed25519', 'automation/user.p12'];
  for (const path of bad) assert.ok(distributionPathIssues([{ path }]).length > 0, path);
  assert.deepEqual(distributionPathIssues([
    { path: 'app.asar/dist/main/credentials.js' }, { path: 'app.asar/dist/automation/profile.js' },
    { path: 'automation/node_modules/playwright-core/browsers.json' },
    { path: 'automation/node_modules/playwright-core/lib/server/chromium', directory: true },
    { path: 'automation/node/lib/node_modules/npm/node_modules/undici/lib/web/cookies', directory: true },
    { path: 'app.asar/dist/licenses/THIRD_PARTY_NOTICES.txt' },
  ]), []);
  assert.ok(distributionPathIssues([{ path: 'Default/Cookies' }]).some(issue => issue.reason.startsWith('Potential credential')));
  assert.ok(distributionPathIssues([{ path: 'app.asar/.env', directory: true }]).length > 0);
});

test('an actual ASAR license inventory contributes compiled renderer versions absent from individual package manifests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pideck-compiled-audit-'));
  const source = join(directory, 'source');
  const resources = join(directory, 'resources');
  async function file(path: string, contents = 'fixture') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  try {
    const { prepareLicenses, prepareInstalledLicenses } = await import(new URL('../scripts/licenses.mjs', import.meta.url).href) as {
      prepareLicenses(root: string): Promise<unknown>;
      prepareInstalledLicenses(directory: string): Promise<unknown>;
    };
    const { npmVersion } = await import(new URL('../scripts/npm-runtime.mjs', import.meta.url).href) as { npmVersion: string };
    await file(join(source, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '0.1.0', license: 'AGPL-3.0-only' }));
    await file(join(source, 'LICENSE'), await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
    await file(join(source, 'src/renderer/main.ts'), 'import "renderer-only";');
    await file(join(source, 'node_modules/renderer-only/package.json'), JSON.stringify({ name: 'renderer-only', version: '1.2.3', license: 'MIT' }));
    await file(join(source, 'node_modules/renderer-only/LICENSE'), 'fixture renderer license');
    await prepareLicenses(source);
    await mkdir(resources);
    // The archive deliberately excludes renderer-only/package.json, as a real
    // frontend bundle does. Its only version evidence is the license inventory.
    await asar.createPackageFromFiles(source, join(resources, 'app.asar'), ['LICENSE', 'package.json',
      'dist/licenses/Pideck-LICENSE.txt', 'dist/licenses/THIRD_PARTY_NOTICES.txt', 'dist/licenses/dependencies.json'].map(path => join(source, path)));
    const automation = join(resources, 'automation');
    const packages: Record<string, { name: string; version: string; dependencies?: Record<string, string> }> = {};
    for (const name of ['@playwright/cli', 'playwright', 'playwright-core']) {
      packages[name] = JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
      await file(join(automation, 'node_modules', name, 'package.json'), JSON.stringify(packages[name]));
      for (const notice of ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt']) await file(join(automation, 'node_modules', name, notice));
    }
    const browserMetadata = await readFile(new URL('../node_modules/playwright-core/browsers.json', import.meta.url), 'utf8');
    const browserRevision = JSON.parse(browserMetadata).browsers.find((browser: { name: string }) => browser.name === 'chromium').revision;
    await file(join(automation, 'node_modules/playwright-core/browsers.json'), browserMetadata);
    await file(join(automation, 'manifest.json'), JSON.stringify({ schema: 2, platform: 'darwin', arch: 'arm64', nodeVersion: '22.23.4', npmVersion,
      cliVersion: packages['@playwright/cli'].version, playwrightVersion: packages.playwright.version, browserRevision,
      node: 'node/bin/node', cli: 'node_modules/@playwright/cli/playwright-cli.js', playwright: 'node_modules/playwright/cli.js' }));
    await file(join(automation, 'node/lib/node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: npmVersion }));
    for (const path of ['node/bin/node', 'node/LICENSE', 'NOTICE.txt', 'node/bin/npm', 'node/bin/npx',
      'node/lib/node_modules/npm/bin/npm-cli.js', 'node/lib/node_modules/npm/bin/npx-cli.js',
      'node/lib/node_modules/npm/LICENSE', 'node/lib/node_modules/npm/PIDECK-DISTRIBUTION.txt',
      'node_modules/@playwright/cli/playwright-cli.js', 'node_modules/@playwright/cli/skillCheck.js', 'node_modules/playwright/cli.js',
      'node_modules/playwright-core/lib/coreBundle.js', 'node_modules/playwright-core/lib/utilsBundle.js',
      'node_modules/playwright-core/lib/entry/cliDaemon.js', 'node_modules/playwright-core/lib/tools/cli-client/program.js']) await file(join(automation, path));
    await prepareInstalledLicenses(join(automation, 'node/lib/node_modules/npm'));
    const report = await checkDistribution(resources, { fetch: async (_url, init) => {
      const query = JSON.parse(String(init?.body));
      assert.deepEqual(query['renderer-only'], ['1.2.3']);
      assert.deepEqual(query.npm, [npmVersion]);
      return new Response(JSON.stringify({ 'renderer-only': [{ title: 'Compiled dependency advisory', severity: 'high', url: 'https://example.invalid/advisory', vulnerable_versions: '1.2.3' }] }));
    } });
    assert.equal(report.status, 'failed');
    assert.ok(report.advisories, report.errors.join('\n'));
    assert.equal(report.advisories?.[0].installed[0].path, 'app.asar/dist/licenses/dependencies.json#renderer-only@1.2.3');
    assert.equal(report.checks.npm?.packageManifestFiles, 4);
    assert.equal(report.checks.npm?.bundledDependencyRecords, 1);
    assert.equal(report.checks.npm?.packageRecords, 5);
    assert.equal(report.checks.npm?.uniquePackageVersions, 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser and media binaries cannot return to the package through an old cache or an alternate location', () => {
  for (const path of ['automation/browsers', 'automation/browsers/chromium-1252/chrome-mac-arm64/chrome',
    'other/ffmpeg-mac', 'other/chrome.exe', 'other/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
    const issues = distributionPathIssues([{ path, directory: path.endsWith('browsers') }]);
    assert.ok(issues.some(issue => issue.reason.startsWith('Browser and FFmpeg')), path);
  }
});

test('the official advisory query includes actual bundled npm versions and filters exact affected versions', async () => {
  const packages = [
    { name: 'example', version: '1.0.0', path: 'app.asar/node_modules/example/package.json' },
    { name: 'example', version: '2.0.0', path: 'automation/node_modules/example/package.json' },
    { name: 'npm-only', version: '3.0.0', path: 'automation/node/lib/node_modules/npm/node_modules/npm-only/package.json' },
  ];
  const audit = await auditPackageVersions(packages, async (url, init) => {
    assert.equal(url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { example: ['1.0.0', '2.0.0'], 'npm-only': ['3.0.0'] });
    return new Response(JSON.stringify({ example: [{ title: 'Fixture advisory', severity: 'high', url: 'https://example.invalid/advisory', vulnerable_versions: '<2.0.0' }] }));
  });
  assert.equal(audit.findings.length, 1);
  assert.deepEqual(audit.findings[0].installed, [{ version: '1.0.0', path: packages[0].path }]);
});

test('offline, unsuccessful, malformed and empty package audits cannot be recorded as zero vulnerabilities', async () => {
  const packages = [{ name: 'example', version: '1.0.0', path: 'node_modules/example/package.json' }];
  await assert.rejects(auditPackageVersions(packages, async () => { throw new Error('offline'); }), /not verified/);
  await assert.rejects(auditPackageVersions(packages, async () => new Response('{}', { status: 503 })), /HTTP 503/);
  await assert.rejects(auditPackageVersions(packages, async () => new Response('invalid json')), /invalid JSON/);
  await assert.rejects(auditPackageVersions(packages, async () => new Response('{"error":"service unavailable"}')), /invalid response/);
  await assert.rejects(auditPackageVersions([], async () => new Response('{}')), /empty audit cannot pass/);
});

test('an ordinary directory is rejected without scanning its data and a failure can be saved as JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pideck-distribution-'));
  try {
    await writeFile(join(directory, 'provider-credentials'), 'fixture private data');
    const reportPath = join(directory, 'report.json');
    let fetched = false;
    const report = await checkDistribution(directory, { report: reportPath, fetch: async () => { fetched = true; return new Response('{}'); } });
    assert.equal(report.status, 'failed');
    assert.ok(report.errors.some(error => error.includes('no app.asar')));
    assert.equal(fetched, false);
    assert.deepEqual(report.pathIssues, []);
    assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
