import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Arch } from 'builder-util';

const { validateAutomationLinks, validateAutomationResources, publishAutomation } = await import(new URL('../scripts/package-assets.mjs', import.meta.url).href) as {
  validateAutomationLinks(root: string): Promise<void>;
  validateAutomationResources(root: string): Promise<unknown>;
  publishAutomation(context: unknown): Promise<void>;
};
const { prepareInstalledLicenses } = await import(new URL('../scripts/licenses.mjs', import.meta.url).href) as {
  prepareInstalledLicenses(directory: string): Promise<unknown>;
};

test('automation resources retain portable framework links after leaving their source directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-assets-links-'));
  const resources = join(temporary, 'resources');
  const framework = join(resources, 'Browser.framework');
  try {
    await mkdir(join(framework, 'Versions', '157', 'Resources'), { recursive: true });
    await writeFile(join(framework, 'Versions', '157', 'Resources', 'browser.pak'), 'fixture');
    await symlink('157', join(framework, 'Versions', 'Current'), 'dir');
    await symlink('Versions/Current/Resources', join(framework, 'Resources'), 'dir');
    await validateAutomationLinks(resources);
    assert.equal(await readlink(join(framework, 'Resources')), 'Versions/Current/Resources');
    // Relocation must preserve the entire multi-link chain, not depend on the
    // original extraction cache still being present on the developer's machine.
    const relocated = join(temporary, 'relocated');
    await cp(resources, relocated, { recursive: true, verbatimSymlinks: true });
    await rename(resources, join(temporary, 'unavailable-original'));
    await validateAutomationLinks(relocated);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const kind of ['absolute', 'relative escape', 'dangling', 'cycle'] as const) {
  test(`automation publishing rejects a ${kind} resource link`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'pideck-assets-invalid-'));
    const resources = join(temporary, 'resources');
    try {
      await mkdir(resources);
      await writeFile(join(temporary, 'build-cache'), 'outside');
      const target = kind === 'absolute' ? join(temporary, 'build-cache')
        : kind === 'relative escape' ? '../build-cache' : kind === 'cycle' ? 'link' : 'missing';
      await symlink(target, join(resources, 'link'));
      await assert.rejects(validateAutomationLinks(resources));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

test('afterPack restores upstream CLI dependencies omitted by the normal resource filter and verifies the final tree', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-published-assets-'));
  const source = join(temporary, 'release', 'automation-assets', 'mac-arm64');
  const resources = join(temporary, 'Pideck.app', 'Contents', 'Resources');
  const published = join(resources, 'automation');
  async function file(path: string, contents = 'fixture') {
    const { dirname } = await import('node:path');
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), contents);
  }
  try {
    for (const name of ['@playwright/cli', 'playwright', 'playwright-core']) {
      await cp(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(source, 'node_modules', name),
        { recursive: true, verbatimSymlinks: true });
    }
    const cli = JSON.parse(await readFile(join(source, 'node_modules', '@playwright', 'cli', 'package.json'), 'utf8'));
    const core = JSON.parse(await readFile(join(source, 'node_modules', 'playwright-core', 'package.json'), 'utf8'));
    const browsers = JSON.parse(await readFile(join(source, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers;
    const chromium = browsers.find((browser: { name: string }) => browser.name === 'chromium').revision;
    const ffmpeg = browsers.find((browser: { name: string }) => browser.name === 'ffmpeg').revision;
    const manifest = { schema: 2, platform: 'darwin', arch: 'arm64', nodeVersion: '22.23.4', npmVersion: '12.2.2',
      cliVersion: cli.version, playwrightVersion: core.version, browserRevision: chromium,
      node: 'node/bin/node', cli: 'node_modules/@playwright/cli/playwright-cli.js',
      playwright: 'node_modules/playwright/cli.js' };
    await file('manifest.json', JSON.stringify(manifest));
    for (const path of [manifest.node, 'node/LICENSE', 'NOTICE.txt', 'node/bin/npm', 'node/bin/npx',
      'node/lib/node_modules/npm/bin/npm-cli.js', 'node/lib/node_modules/npm/bin/npx-cli.js',
      'node/lib/node_modules/npm/LICENSE', 'node/lib/node_modules/npm/PIDECK-DISTRIBUTION.txt']) await file(path);
    await file('node/lib/node_modules/npm/package.json', JSON.stringify({ name: 'npm', version: '12.2.2', license: 'Artistic-2.0' }));
    await prepareInstalledLicenses(join(source, 'node/lib/node_modules/npm'));
    await validateAutomationResources(source);
    await cp(source, published, { recursive: true, verbatimSymlinks: true,
      filter: path => path !== join(source, 'node_modules') });
    await assert.rejects(validateAutomationResources(published), /missing or empty: node_modules/);
    await publishAutomation({ arch: Arch.arm64, appOutDir: temporary, packager: {
      projectDir: temporary, platform: { nodeName: 'darwin' }, getResourcesDir: () => resources,
    } });
    await validateAutomationResources(published);
    await mkdir(join(published, 'browsers'));
    await assert.rejects(validateAutomationResources(published), /must not be redistributed/);
    await rm(join(published, 'browsers'), { recursive: true });
    assert.equal(await readFile(join(published, manifest.cli), 'utf8'), await readFile(join(source, manifest.cli), 'utf8'));
    await rm(join(published, 'node/lib/node_modules/npm'), { recursive: true });
    await assert.rejects(validateAutomationResources(published), /missing or empty: node\/lib\/node_modules\/npm/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
