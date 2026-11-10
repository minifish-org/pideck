async page => {
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function captureThemes(kind) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: theme })), theme);
      await page.waitForFunction(theme => document.documentElement.dataset.colorMode === theme, theme);
      await page.screenshot({ path: `output/playwright/pideck-navigation-${kind}-${theme}.png` });
    }
  }
  const projectId = '74de4c42-3a46-4430-873c-9bcb42fdb287';
  const otherId = '5746b747-730d-45df-94c5-717355475784';
  const rootId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
  const childId = '3dd96030-16c4-4319-9a8b-6a10258dbf82';
  const leafId = '4dd96030-16c4-4319-9a8b-6a10258dbf82';
  await page.addInitScript(({ otherId }) => {
    if (!window.pideck) return;
    const original = window.pideck.invoke;
    window.navigationVerification = { calls: [] };
    window.pideck.invoke = async (command, payload) => {
      window.navigationVerification.calls.push({ command, payload });
      if (command === 'session:list' && payload.projectId === otherId) {
        if (sessionStorage.getItem('navigation-fail-other')) throw new Error('Fixture session list unavailable.');
        if (sessionStorage.getItem('navigation-hold-other')) await new Promise(resolve => { window.navigationVerification.release = resolve; });
      }
      return original(command, payload);
    };
  }, { otherId });
  await page.evaluate(({ projectId, rootId, childId, leafId }) => {
    localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem('navigation-hold-other', '1');
    const sessions = [[rootId, 'Login flow'], [childId, '修复登录'], [leafId, 'Delete this session']]
      .map(([id, title], index) => ({ id, title, projectId, createdAt: index + 1, updatedAt: index + 1 }));
    const view = { status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'off', messages: [
      { id: 'user', entryId: 2, role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Review this session.' }] },
      { id: 'answer', entryId: 3, role: 'assistant', completed: true, timestamp: 2, blocks: [{ type: 'text', text: 'Ready for review.' }] },
    ] };
    localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, secondOpened: true, configured: true,
      projectId, sessions, views: Object.fromEntries(sessions.map(session => [session.id, view])), parents: { [childId]: rootId } }));
    localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: rootId }, navigation: true, reading: {}, reviewPaths: {} }));
  }, { projectId, rootId, childId, leafId });
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  const nav = page.getByRole('complementary', { name: 'Workspace navigation' });
  const prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
  const project = page.locator(`#nav-project-${projectId}`);
  const other = page.locator(`#nav-project-${otherId}`);
  const root = page.locator(`#nav-session-${rootId}`);
  const child = page.locator(`#nav-session-${childId}`);
  const leaf = page.locator(`#nav-session-${leafId}`);
  await root.waitFor();
  await prompt.fill('Do not send this ordinary draft.');
  await page.mouse.move(1200, 20);
  if (await nav.locator('.nav-remove').count()) throw new Error('Old hidden removal buttons remain.');
  if (!await nav.locator('.nav-new-session').evaluateAll(buttons => buttons.length === 2 && buttons.every(button =>
    getComputedStyle(button).opacity === '1' && getComputedStyle(button).pointerEvents !== 'none'))) throw new Error('Project new-session buttons are not always available.');
  const searchButton = nav.getByRole('button', { name: 'Search sessions', exact: true });
  const searchBounds = await searchButton.boundingBox();
  const plusBounds = await nav.locator('#nav-open-project').boundingBox();
  if (searchBounds.x + searchBounds.width > plusBounds.x) throw new Error('Session search must sit to the left of Open Folder.');
  await root.press('ArrowLeft');
  await child.waitFor({ state: 'detached' });
  await searchButton.click();
  const search = page.getByRole('dialog', { name: 'Search sessions', exact: true });
  const field = search.getByRole('combobox', { name: 'Search sessions', exact: true });
  await search.getByText('Loading sessions…', { exact: true }).waitFor();
  await page.evaluate(() => { sessionStorage.removeItem('navigation-hold-other'); window.navigationVerification.release(); });
  await search.getByRole('option', { name: /Other task/ }).waitFor();
  await captureThemes('search');
  await field.fill('  ＬＯＧＩＮ  ');
  if (await search.getByRole('option').count() !== 1) throw new Error('Search did not normalize title case and Unicode.');
  await field.fill('missing session');
  await search.getByText('No sessions found.', { exact: true }).waitFor();
  await field.fill('Sample project');
  if (await search.getByRole('option').count() !== 3) throw new Error('Search did not match project names.');
  const first = await field.getAttribute('aria-activedescendant');
  await field.press('ArrowDown');
  if (await field.getAttribute('aria-activedescendant') === first) throw new Error('Search keyboard selection did not move.');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  if (!await search.isVisible()) throw new Error('IME confirmation unexpectedly opened a session.');
  await field.fill('登录');
  await field.press('Enter');
  await search.waitFor({ state: 'detached' });
  await child.waitFor();
  if (await child.getAttribute('aria-current') !== 'true') throw new Error('A collapsed search result did not open and reveal its ancestors.');
  const shortcut = await page.evaluate(() => window.pideck.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.press(shortcut);
  await field.fill('other');
  await field.press('Enter');
  await search.waitFor({ state: 'detached' });
  await page.locator('#nav-session-0c1bd9dc-58bd-4918-92ee-bc30609f0dbd[aria-current="true"]').waitFor();
  await root.click();
  if (await prompt.inputValue() !== 'Do not send this ordinary draft.') throw new Error('Session search lost the ordinary draft.');
  await other.click();
  const selected = () => page.evaluate(() => JSON.parse(localStorage.getItem('pideck.workspace.v1')).projectId);
  const previous = await selected();
  await project.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Remove project…', exact: true }).waitFor();
  if (await selected() !== previous) throw new Error('Right-clicking a project changed selection.');
  await captureThemes('project-menu');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  if (!await project.evaluate(button => button === document.activeElement)) throw new Error('Closing a project menu lost row focus.');
  await project.press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Remove project…', exact: true }).waitFor();
  await prompt.click();
  await menu.waitFor({ state: 'detached' });
  await leaf.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Remove session…', exact: true }).waitFor();
  await captureThemes('session-menu');
  await menu.getByRole('menuitem', { name: 'Remove session…', exact: true }).click();
  await menu.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.body.dataset.staleSessionList === 'started');
  if (await selected() !== previous || !await leaf.evaluate(button => button === document.activeElement)) throw new Error('Cancelling session removal changed selection or row focus.');
  await leaf.press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Remove session…', exact: true }).press('Enter');
  await leaf.waitFor({ state: 'detached' });
  await page.keyboard.press(shortcut);
  await field.fill('Delete this session');
  await search.getByText('No sessions found.', { exact: true }).waitFor();
  await field.press('Escape');
  await search.waitFor({ state: 'detached' });
  await project.dispatchEvent('contextmenu', { clientX: 1278, clientY: 898 });
  await menu.waitFor();
  const clamped = await menu.boundingBox();
  if (clamped.x < 0 || clamped.y < 0 || clamped.x + clamped.width > 1280 || clamped.y + clamped.height > 900) throw new Error('A context menu escaped the viewport.');
  await page.keyboard.press('Escape');
  await page.evaluate(({ projectId, otherId }) => {
    const preferences = JSON.parse(localStorage.getItem('pideck.workspace.v1'));
    preferences.projectId = projectId;
    localStorage.setItem('pideck.workspace.v1', JSON.stringify(preferences));
    sessionStorage.setItem('navigation-fail-other', '1');
  }, { projectId, otherId });
  await page.reload();
  await searchButton.click();
  await search.getByRole('alert').filter({ hasText: 'Could not load Other project.' }).waitFor();
  await page.evaluate(() => sessionStorage.removeItem('navigation-fail-other'));
  await search.getByRole('button', { name: 'Retry', exact: true }).click();
  await search.getByRole('option', { name: /Other task/ }).waitFor();
  await search.getByRole('alert').waitFor({ state: 'detached' });
  await field.press('Escape');
  await page.setViewportSize({ width: 720, height: 800 });
  await page.keyboard.press(shortcut);
  await field.fill('other');
  await search.getByRole('option', { name: /Other task/ }).waitFor();
  await page.screenshot({ path: 'output/playwright/pideck-navigation-search-narrow.png' });
  await field.press('Enter');
  await search.waitFor({ state: 'detached' });
  if (await nav.count()) throw new Error('Selecting a search result left the narrow navigation drawer open.');
  await page.waitForFunction(() => document.activeElement?.id === 'prompt');
  if (errors.length) throw new Error(errors.join('\n'));
  return 'Navigation flow passed: cross-project session search, collapsed branches, loading/retry, keyboard and IME, always-visible new-session buttons, and safe project/session context menus.';
}
