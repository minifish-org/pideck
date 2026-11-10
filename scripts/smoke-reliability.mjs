import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { _electron, chromium } from 'playwright';
import { openSmokeProvider } from './smoke-provider.mjs';

// Real packaged Electron, its trusted host/SQLite/PTYs, and a loopback model.
// Crash injection and a disposable profile never touch the user's workspace.
if (process.platform !== 'darwin') throw new Error('This packaged reliability acceptance targets macOS.');
const executable = resolve(process.argv[2] ?? `release/mac-${process.arch}/Pideck.app/Contents/MacOS/Pideck`);
const temporary = await mkdtemp(join(tmpdir(), 'pideck-reliability-'));
const directory = join(temporary, 'reliability-project');
const profile = join(temporary, 'profile');
const profiles = join(temporary, 'shell-profiles');
const output = resolve('output/playwright/reliability-native');
const results = { executable, checks: [] };
const errors = [];
let application;
let provider;
let page;
let renderer;
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* A crashed document is replaced asynchronously. */ }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const command = (name, payload) => page.evaluate(([name, payload]) => window.pideck.invoke(name, payload), [name, payload]);
const promptText = 'Unsent draft retained across native crashes.';
const edited = 'Edited queue retained across native crashes.';
const hold = 'Queue hold RELOAD';
const countPrompt = text => provider.requests.filter(request => JSON.stringify(request.input.findLast(item => item.role === 'user')?.content).includes(text)).length;

try {
  await Promise.all([mkdir(directory), mkdir(profiles), mkdir(output, { recursive: true })]);
  await writeFile(join(directory, 'example.ts'), "export const result = 'before';\n");
  await writeFile(join(profiles, '.zshrc'), "PS1='native$ '\n");
  provider = await openSmokeProvider();
  application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`],
    env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: profiles,
      AZURE_OPENAI_API_KEY: 'pideck-smoke-key', AZURE_OPENAI_BASE_URL: provider.endpoint } });
  results.processIds = { runner: process.pid, electron: application.process().pid };
  console.log('Reliability process IDs:', JSON.stringify(results.processIds));
  page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ app, BrowserWindow, dialog, Notification }, directory) => {
    const state = globalThis.__reliability = { directory, dialogs: [], loads: 0 };
    Notification.isSupported = () => false;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [state.directory] });
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1); state.dialogs.push(options);
      if (options.buttons?.[0] === 'Recover Interface') return new Promise(resolve => { state.recover = resolve; });
      return { response: options.buttons?.[1] === 'Remove' ? 1 : 0 };
    };
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1420, 900); window.show(); app.focus({ steal: true }); window.focus();
    window.webContents.on('did-start-loading', () => state.loads++);
  }, directory);
  await page.getByRole('button', { name: /^Open (?:a project )?folder$/i }).click();
  const [project] = await command('project:list');
  assert.equal(project.directory, await realpath(directory));
  let prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
  await prompt.waitFor();
  const catalog = await command('model:list');
  const model = catalog.models.find(item => item.provider === 'azure' && item.id === 'gpt-4.1');
  assert.equal(model?.configured, true);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('gpt-4.1');
  await picker.getByRole('button', { name: /Azure/i }).filter({ has: page.getByText(model.name, { exact: true }) }).click();
  await prompt.fill('Update example.ts and verify it.');
  await prompt.press('Enter');
  await page.getByText('Package stream verified with the real coding tools.', { exact: true }).waitFor();
  const [session] = await command('session:list', { projectId: project.id });
  const selection = { projectId: project.id, sessionId: session.id };

  await prompt.fill(hold); await prompt.press('Enter');
  await provider.waitForGate(hold);
  await prompt.fill('Original queued message.'); await prompt.press('Enter');
  let queue = page.getByRole('list', { name: 'Queued messages' });
  await queue.getByText('Original queued message.', { exact: true }).waitFor();
  await prompt.fill(promptText);
  await page.locator('input[type="file"]').setInputFiles({ name: 'native-draft.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Preview attached image 1', exact: true }).waitFor();

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('region', { name: 'Project terminal' }).getByText('Shell running', { exact: true }).waitFor();
  const terminal = await command('terminal:open', { projectId: project.id, cols: 100, rows: 24 });
  await command('terminal:input', { projectId: project.id, terminalId: terminal.terminalId,
    data: "printf 'once\\n' >> terminal-once; printf 'RECOVERY_PTY_READY\\n'; sleep 8; printf 'RECOVERY_PTY_DONE\\n'\r" });
  await until(async () => await readFile(join(directory, 'terminal-once'), 'utf8') === 'once\n', 'initial PTY input');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const queued = queue.getByRole('listitem').filter({ hasText: 'Original queued message.' });
  await queued.hover(); await queued.getByRole('button', { name: 'Edit message', exact: true }).click();
  let editor = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
  await editor.fill(edited);
  const draftKey = `pideck.draft.v1/${project.id}/${session.id}`;
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
  assert.equal(saved.queueEdit.text, edited);
  assert.ok(saved.attachmentsKey);

  const crash = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  async function reconnectRenderer() {
    // Playwright intentionally leaves its original Page marked as crashed.
    // Reconnect the debugger to the recovered document, without reloading it.
    await renderer?.close();
    const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    renderer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = renderer.contexts()[0].pages()[0];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
    queue = page.getByRole('list', { name: 'Queued messages' });
    editor = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
  }

  await crash();
  await until(() => application.evaluate(() => globalThis.__reliability.loads > 0), 'automatic reload started');
  await reconnectRenderer();
  await until(async () => await editor.inputValue() === edited && !await editor.evaluate(element => element.readOnly), 'automatic renderer recovery');
  assert.equal(countPrompt(hold), 1, 'a renderer crash must not restart the active Durable request');
  assert.equal((await application.evaluate(() => globalThis.__reliability.dialogs)).length, 0, 'the first crash recovers without a dialog');
  let restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
  assert.equal(restored.queueEdit.token, saved.queueEdit.token, 'the existing edit reservation is reattached');
  assert.equal(restored.attachmentsKey, saved.attachmentsKey);
  results.checks.push('automatic renderer crash recovery preserves the active request, queue reservation and image draft without resubmission');

  await crash();
  await until(() => application.evaluate(() => Boolean(globalThis.__reliability.recover)), 'consecutive crash recovery prompt');
  const before = await application.evaluate(() => globalThis.__reliability.loads);
  await delay(300);
  assert.equal(await application.evaluate(() => globalThis.__reliability.loads), before, 'a consecutive crash must not reload in a loop');
  const dialogs = await application.evaluate(() => globalThis.__reliability.dialogs);
  assert.deepEqual(dialogs[0].buttons, ['Recover Interface', 'Close Window']);
  await application.evaluate(() => globalThis.__reliability.recover({ response: 0 }));
  await reconnectRenderer();
  await until(async () => await editor.inputValue() === edited && !await editor.evaluate(element => element.readOnly), 'manual recovery');
  restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
  assert.equal(restored.queueEdit.token, saved.queueEdit.token);
  assert.equal(countPrompt(hold), 1);
  const reopened = await command('terminal:open', { projectId: project.id, cols: 100, rows: 24 });
  assert.equal(reopened.terminalId, terminal.terminalId, 'renderer recovery reattaches the same shell');
  await command('terminal:visibility', { projectId: project.id, terminalId: terminal.terminalId, visible: false });
  assert.equal(await readFile(join(directory, 'terminal-once'), 'utf8'), 'once\n');
  await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await page.getByRole('button', { name: 'Preview attached image 1', exact: true }).waitFor();
  assert.equal(await prompt.inputValue(), promptText);
  await page.locator('diffs-container').filter({ hasText: 'after' }).waitFor();
  await page.screenshot({ path: join(output, 'recovered.png') });
  results.checks.push('consecutive crashes require explicit recovery; original PTY/input, draft images/text and edited queue survive');
  provider.releaseGate(hold);
  await until(() => countPrompt(edited) === 1, 'released edited queue');
  await queue.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Cancel run', exact: true }).waitFor({ state: 'visible' });
  await until(() => page.getByRole('button', { name: 'Cancel run', exact: true }).isDisabled(), 'completed queued run');
  assert.equal(countPrompt(hold), 1); assert.equal(countPrompt(edited), 1); assert.equal(countPrompt(promptText), 0);

  await command('chat:send', { ...selection, requestId: crypto.randomUUID(), text: 'Native quota diagnostic',
    model: { provider: 'azure', id: 'gpt-4.1' }, thinking: 'off', delivery: 'send' });
  const failure = page.locator('.composer-run [role="alert"]');
  await failure.filter({ hasText: 'Quota exhausted for this project' }).waitFor();
  const detail = await failure.innerText();
  assert.ok(!detail.includes('sk-pideck-smoke-secret'));
  assert.ok(detail.includes('[redacted]'));
  await page.screenshot({ path: join(output, 'failure-detail.png') });
  results.checks.push('a real HTTP 429 retains the provider cause while redacting its credential');

  // Exercise the unmodified worker's capacity path with actual safe/unsafe PTYs.
  await page.evaluate(() => { window.nativeTerminalEvents = []; window.pideck.onEvent(event => { if (event.type.startsWith('terminal:')) window.nativeTerminalEvents.push(event); }); });
  await until(async () => (await command('terminal:open', { projectId: project.id, cols: 100, rows: 24 })).data.includes('RECOVERY_PTY_DONE'), 'original PTY job completion');
  await command('terminal:visibility', { projectId: project.id, terminalId: terminal.terminalId, visible: false });
  await command('terminal:input', { projectId: project.id, terminalId: terminal.terminalId, data: 'sleep 30\r' });
  for (let index = 0; index < 5; index++) {
    const next = join(temporary, `idle-${index}`); await mkdir(next);
    await application.evaluate((_electron, directory) => { globalThis.__reliability.directory = directory; }, next);
    await page.locator('#nav-open-project').click();
    await page.getByRole('button', { name: `idle-${index}`, exact: true }).waitFor();
    const target = (await command('project:list')).find(item => item.directory === next || item.directory.endsWith(`/idle-${index}`));
    const shell = await command('terminal:open', { projectId: target.id, cols: 100, rows: 24 });
    await page.waitForFunction(id => window.nativeTerminalEvents.filter(event => event.terminalId === id && event.type === 'terminal:data').map(event => event.data).join('').includes('native$ '), shell.terminalId);
    await command('terminal:visibility', { projectId: target.id, terminalId: shell.terminalId, visible: false });
  }
  const reclaimed = await page.evaluate(() => window.nativeTerminalEvents.filter(event => event.type === 'terminal:reclaimed'));
  assert.ok(reclaimed.length >= 2);
  assert.ok(!reclaimed.some(event => event.terminalId === terminal.terminalId), 'capacity pressure must not kill a silent foreground task');
  assert.equal((await application.evaluate(() => globalThis.__reliability.dialogs)).length, 1, 'terminal reclamation does not display dialogs');
  await command('terminal:close', { projectId: project.id, terminalId: terminal.terminalId });
  results.checks.push('the real host silently reclaims safe hidden shells under capacity pressure, retaining a silent foreground task');

  // Accelerate only the test clock; use the packaged native node-pty binary.
  const resourcePath = await application.evaluate(() => process.resourcesPath);
  const bundle = join(temporary, 'terminal-idle.cjs');
  await build({ entryPoints: [resolve('test/support/terminal-idle.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'packaged-pty', setup(builder) { builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: join(resourcePath, 'app.asar/node_modules/node-pty/lib/index.js'), external: true })); } }] });
  const terminalBundle = join(temporary, 'terminals.cjs');
  await build({ entryPoints: [resolve('src/host/terminal.ts')], outfile: terminalBundle, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'packaged-pty', setup(builder) { builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: join(resourcePath, 'app.asar/node_modules/node-pty/lib/index.js'), external: true })); } }] });
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    const home = join(temporary, shell.endsWith('zsh') ? 'zsh-home' : 'bash-home'); await mkdir(home);
    const checks = await application.evaluate(async (_electron, { bundle, terminalBundle, home, shell }) => {
      const require = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(process.cwd(), '__reliability.cjs'));
      return require(bundle).exerciseTerminalRecycling(require(terminalBundle).Terminals, home, shell);
    }, { bundle, terminalBundle, home, shell });
    assert.equal(checks.length, 8); results.checks.push(`${shell}: ${checks.join(', ')}`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(provider.failures, []);
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  try { await page?.screenshot({ path: join(output, 'failure.png'), timeout: 3000 }); } catch {}
  console.error(error); process.exitCode = 1;
} finally {
  if (provider) provider.releaseGate(hold);
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
  await renderer?.close().catch(() => {});
  await application?.close().catch(() => {});
  await provider?.close();
  await rm(temporary, { recursive: true, force: true });
}
