async page => {
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const projectId = '74de4c42-3a46-4430-873c-9bcb42fdb287';
  const rootId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
  const childId = '3dd96030-16c4-4319-9a8b-6a10258dbf82';
  const grandchildId = '4dd96030-16c4-4319-9a8b-6a10258dbf82';
  const standaloneId = '5dd96030-16c4-4319-9a8b-6a10258dbf82';
  const siblingId = '6dd96030-16c4-4319-9a8b-6a10258dbf82';
  await page.addInitScript(() => {
    if (!window.pideck) return;
    const original = window.pideck;
    const listeners = new Set();
    const calls = [];
    window.reliability = { calls, emit: event => { for (const listener of listeners) listener(event); } };
    window.pideck = { ...original,
      onEvent(listener) { listeners.add(listener); const stop = original.onEvent(listener); return () => { listeners.delete(listener); stop(); }; },
      async invoke(command, payload) {
        calls.push({ command, payload });
        if (['chat:send', 'chat:start', 'chat:continue'].includes(command)) sessionStorage.setItem('reliability-submissions', String(Number(sessionStorage.getItem('reliability-submissions') || 0) + 1));
        if (command === 'draft:images-read' && sessionStorage.getItem('reliability-image-failure')) {
          throw new Error('Fixture attachment store temporarily unavailable.');
        }
        if (command === 'model:providers') return (await original.invoke(command, payload)).map(item => item.id === 'other'
          ? { ...item, configured: false, credential: sessionStorage.getItem('reliability-removed') ? undefined : 'api_key' } : item);
        if (command === 'model:logout' && payload.provider === 'other') sessionStorage.setItem('reliability-removed', '1');
        if (command === 'session:read-activity') {
          const watch = calls.filter(call => call.command === 'session:watch-activity').at(-1)?.payload;
          if (watch) queueMicrotask(() => window.reliability.emit({ type: 'session:activity', subscriptionId: watch.subscriptionId, items: [] }));
        }
        return original.invoke(command, payload);
      },
    };
  });
  await page.evaluate(({ projectId, rootId, childId, grandchildId, standaloneId, siblingId }) => {
    localStorage.clear(); sessionStorage.clear();
    const sessions = [[standaloneId, 'New conversation'], [grandchildId, 'Adjust validation'], [childId, 'Try approach B'],
      [siblingId, 'Try approach C'], [rootId, 'Login refactor']]
      .map(([id, title], index) => ({ id, title, projectId, createdAt: index + 1, updatedAt: index + 1 }));
    const view = { status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'high',
      messages: [{ id: 'user', entryId: 2, role: 'user', blocks: [{ type: 'text', text: 'Review the login flow.' }] },
        { id: 'answer', entryId: 3, role: 'assistant', completed: true, blocks: [{ type: 'text', text: 'The source is ready for review.' }] }] };
    localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, credential: 'api_key',
      projectId, sessions, views: Object.fromEntries(sessions.map(session => [session.id, view])),
      parents: { [childId]: rootId, [grandchildId]: childId, [siblingId]: rootId } }));
    localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: rootId }, navigation: true, reading: {}, reviewPaths: {} }));
  }, { projectId, rootId, childId, grandchildId, standaloneId, siblingId });
  await page.reload();
  await page.setViewportSize({ width: 1420, height: 900 });
  const prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
  await prompt.waitFor();
  const root = page.locator(`#nav-session-${rootId}`);
  const child = page.locator(`#nav-session-${childId}`);
  const grandchild = page.locator(`#nav-session-${grandchildId}`);
  await grandchild.waitFor();
  if (await child.locator('..').getAttribute('data-parent-session') !== rootId) throw new Error('The child lost its native source.');
  if (await page.locator('.nav-session-item .nav-disclosure').count()) throw new Error('Sessions still expose fork collapse controls.');
  const projectRow = page.locator(`#nav-project-${projectId}`);
  const standalone = page.locator(`#nav-session-${standaloneId}`);
  const textLeft = row => row.locator('span').first().evaluate(element => element.getBoundingClientRect().left);
  if (Math.abs(await textLeft(root) - await textLeft(projectRow)) > 2
    || await textLeft(standalone) !== await textLeft(root)) throw new Error('Root sessions still reserve extra indentation.');
  if (await textLeft(child) - await textLeft(root) !== 12
    || await textLeft(grandchild) - await textLeft(child) !== 12) throw new Error('Fork indentation is not compact.');
  for (const [row, width] of [[child, 12], [grandchild, 24], [page.locator(`#nav-session-${siblingId}`), 12]]) {
    const guide = row.locator('..').locator('.nav-session-guides');
    if (!await guide.evaluate((element, width) => element.getBoundingClientRect().width === width
      && getComputedStyle(element).backgroundImage !== 'none', width)) throw new Error('A fork lost its ancestry guides.');
  }
  if (await standalone.locator('..').locator('.nav-session-guides').count()) throw new Error('A root session has a fork guide placeholder.');
  await root.press('ArrowRight');
  if (!await child.evaluate(element => element === document.activeElement)) throw new Error('ArrowRight did not enter the branch.');
  await child.press('ArrowRight');
  if (!await grandchild.evaluate(element => element === document.activeElement)) throw new Error('ArrowRight did not enter the nested branch.');
  await grandchild.press('ArrowLeft');
  if (!await child.evaluate(element => element === document.activeElement)) throw new Error('ArrowLeft did not return to the parent.');
  await child.press('ArrowLeft');
  if (!await root.evaluate(element => element === document.activeElement)) throw new Error('ArrowLeft did not return to the source.');
  await root.press('ArrowLeft');
  if (!await projectRow.evaluate(element => element === document.activeElement)
    || !await grandchild.isVisible()) throw new Error('ArrowLeft collapsed a session instead of focusing its parent.');
  await page.getByRole('button', { name: 'Collapse Sample project', exact: true }).click();
  await grandchild.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Expand Sample project', exact: true }).click();
  await grandchild.waitFor();
  await root.click();
  await page.screenshot({ path: 'output/playwright/pideck-reliability-tree.png' });

  const changes = page.getByRole('button', { name: 'Changes', exact: true });
  const terminal = page.getByRole('button', { name: 'Terminal', exact: true });
  for (const width of [1420, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const initial = await changes.boundingBox();
    for (const button of [changes, terminal, terminal]) {
      await button.click();
      const current = await changes.boundingBox();
      if (Math.abs(current.x - initial.x) > 1 || Math.abs(current.y - initial.y) > 1) throw new Error('The global toolbar moved when panels changed.');
    }
  }
  if (await page.locator('.titlebar').getByRole('button', { name: /New session|Resume unsent draft/ }).count()) throw new Error('The removed titlebar new-session entry returned.');
  await page.setViewportSize({ width: 1420, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sidebar = page.locator('#toggle-navigation');
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();

  await page.evaluate(({ projectId, rootId }) => {
    const watch = window.reliability.calls.filter(call => call.command === 'chat:watch').at(-1).payload;
    const activity = window.reliability.calls.filter(call => call.command === 'session:watch-activity').at(-1).payload;
    window.reliability.emit({ type: 'chat:update', ...watch, sequence: 2, ops: [
      ['s', ['runOutcome'], { kind: 'failed', taskId: 9003, message: '429 quota exhausted: insufficient credits' }],
      ['s', ['error'], '429 quota exhausted: insufficient credits'], ['s', ['failureTaskId'], 9003], ['s', ['canContinue'], true],
    ] });
    window.reliability.emit({ type: 'session:activity', subscriptionId: activity.subscriptionId,
      items: [{ projectId, sessionId: rootId, taskId: 9003, state: 'attention', settled: true }] });
  }, { projectId, rootId });
  await prompt.focus();
  await page.waitForFunction(() => window.reliability.calls.some(call => call.command === 'session:read-activity' && call.payload.taskId === 9003));
  await page.locator('[data-activity="attention"]').waitFor({ state: 'detached' });
  await page.locator('.composer-run [role="alert"]').getByText('429 quota exhausted: insufficient credits', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Model providers', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model providers' });
  await dialog.locator('select').first().selectOption('other');
  await dialog.getByText('Saved connection unavailable', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/pideck-reliability-connection.png' });
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => window.reliability.calls.some(call => call.command === 'model:logout' && call.payload.provider === 'other'));
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await prompt.fill('Keep the screenshot and draft configuration.');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 100;
    const context = canvas.getContext('2d'); context.fillStyle = '#151b23'; context.fillRect(0, 0, 240, 100);
    context.fillStyle = '#3fb950'; context.font = '18px sans-serif'; context.fillText('Retained draft image', 20, 56);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: 'Preview attached image 1' }).waitFor();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('slider', { name: 'Thinking level' }).fill('1');
  await page.getByRole('searchbox', { name: 'Search models' }).press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'Preview attached image 1' }).waitFor();
  if (await prompt.inputValue() !== 'Keep the screenshot and draft configuration.') throw new Error('Draft text was lost.');
  if (!(await page.getByRole('button', { name: 'Model', exact: true }).getAttribute('aria-description')).endsWith('Thinking low')) throw new Error('Thinking selection was not restored.');
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('button', { name: /Fixture fixed model with/ }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Preview attached image 1' }).waitFor();
  await page.locator('.model-summary-name').getByText(/Fixture fixed model/).waitFor();
  await page.screenshot({ path: 'output/playwright/pideck-reliability-draft.png' });
  await page.evaluate(() => sessionStorage.setItem('reliability-image-failure', 'once'));
  await page.reload();
  await page.getByRole('button', { name: 'Retry images', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()) throw new Error('A failed image restore enabled text-only submission.');
  await page.evaluate(() => sessionStorage.removeItem('reliability-image-failure'));
  await page.getByRole('button', { name: 'Retry images', exact: true }).click();
  await page.getByRole('button', { name: 'Preview attached image 1' }).waitFor();

  await page.evaluate(() => {
    const watch = window.reliability.calls.filter(call => call.command === 'chat:watch').at(-1).payload;
    window.reliability.emit({ type: 'chat:update', ...watch, sequence: 2, ops: [
      ['s', ['status'], 'running'], ['s', ['queued'], [{ id: 101, delivery: 'follow-up', preview: 'Check the focused change.' }, { id: 102, delivery: 'follow-up', preview: 'Verify the result.' }]],
      ['s', ['canSteerQueued'], true],
    ] });
  });
  const row = page.getByRole('listitem').filter({ hasText: 'Check the focused change.' });
  await row.waitFor();
  await page.mouse.move(0, 0); await prompt.focus();
  const actions = row.locator('.queue-actions');
  if (await actions.evaluate(element => getComputedStyle(element).opacity) !== '0') throw new Error('Queue actions are not hidden at rest.');
  const before = await row.locator('.queued-preview').boundingBox();
  await row.hover();
  if (await actions.evaluate(element => getComputedStyle(element).opacity) !== '1') throw new Error('Queue actions did not appear on hover.');
  const after = await row.locator('.queued-preview').boundingBox();
  if (before.x !== after.x || before.width !== after.width) throw new Error('Hovering queue actions moved the text.');
  await page.mouse.move(0, 0); await row.getByRole('button', { name: 'Edit message', exact: true }).focus();
  if (await actions.evaluate(element => getComputedStyle(element).opacity) !== '1') throw new Error('Keyboard focus did not reveal queue actions.');
  await page.screenshot({ path: 'output/playwright/pideck-reliability-queue.png' });

  const terminalPanel = page.getByRole('region', { name: 'Project terminal' });
  await terminal.click();
  await terminalPanel.getByText('Shell running', { exact: true }).waitFor();
  const originalPty = await page.evaluate(() => document.body.dataset.terminalId);
  await terminal.click();
  await page.evaluate(({ projectId, terminalId }) => window.reliability.emit({ type: 'terminal:reclaimed', projectId, terminalId, sequence: 3 }), { projectId, terminalId: originalPty });
  await page.locator('.workspace-terminal-status[data-state="reclaimed"]').waitFor({ state: 'attached' });
  await terminal.click();
  await terminalPanel.getByText('Shell running', { exact: true }).waitFor();
  await page.waitForFunction(id => document.body.dataset.terminalId !== id, originalPty);
  const hiddenPty = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.reliabilityHidden ? 'hidden' : 'visible' });
    window.reliabilityHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    return document.body.dataset.terminalId;
  });
  await page.evaluate(({ projectId, terminalId }) => window.reliability.emit({ type: 'terminal:reclaimed', projectId, terminalId, sequence: 3 }), { projectId, terminalId: hiddenPty });
  await page.locator('.workspace-terminal-status[data-state="reclaimed"]').waitFor({ state: 'attached' });
  if (await page.evaluate(() => document.body.dataset.terminalId) !== hiddenPty) throw new Error('A hidden document immediately restarted its reclaimed shell.');
  await page.evaluate(() => { window.reliabilityHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await terminalPanel.getByText('Shell running', { exact: true }).waitFor();
  await page.waitForFunction(id => document.body.dataset.terminalId !== id, hiddenPty);
  if (/Starting a new shell|Workspace reconnected|reclaimed/i.test(await terminalPanel.innerText())) throw new Error('Automatic terminal reopening displayed a notice.');
  await page.screenshot({ path: 'output/playwright/pideck-reliability-terminal.png' });
  await page.evaluate(() => { delete document.visibilityState; delete window.reliabilityHidden; });
  await terminal.click();

  await page.evaluate(() => {
    const watch = window.reliability.calls.filter(call => call.command === 'chat:watch').at(-1).payload;
    window.reliability.emit({ type: 'chat:update', ...watch, sequence: 3, ops: [['s', ['messages'], null]] });
  });
  await page.getByRole('button', { name: 'Recover workspace', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/pideck-reliability-recovery.png' });
  await page.getByRole('button', { name: 'Recover workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Preview attached image 1' }).waitFor();
  if (await prompt.inputValue() !== 'Keep the screenshot and draft configuration.') throw new Error('Recovering the interface lost the draft.');
  if (await page.evaluate(() => Number(sessionStorage.getItem('reliability-submissions') || 0)) !== 0) throw new Error('Recovering the interface resubmitted input.');
  if (errors.length) throw new Error(errors.join('\n'));
  return 'Reliability flow passed: branch navigation, stable toolbar, failure read receipts, unavailable connection removal, image/model/thinking recovery, queue hover/focus, and React recovery without resubmission.';
}
