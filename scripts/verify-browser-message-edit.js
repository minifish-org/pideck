async page => {
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const projectId = '74de4c42-3a46-4430-873c-9bcb42fdb287';
  const sessionId = '7dd96030-16c4-4319-9a8b-6a10258dbf82';
  await page.addInitScript(() => {
    if (!window.pideck) return;
    const original = window.pideck.invoke;
    window.messageEditVerification = { calls: [] };
    window.pideck.invoke = async (command, payload) => {
      window.messageEditVerification.calls.push({ command, payload });
      if (command === 'chat:edit-read' && sessionStorage.getItem('edit-reject-read')) {
        throw new Error('The fixture could not load this message.');
      }
      if (command === 'chat:edit' && sessionStorage.getItem('edit-reject-send')) {
        sessionStorage.removeItem('edit-reject-send');
        throw new Error('The fixture rejected the edit.');
      }
      if (command === 'chat:edit' && sessionStorage.getItem('edit-lose-reply')) {
        sessionStorage.removeItem('edit-lose-reply');
        await new Promise(resolve => { window.messageEditVerification.release = resolve; });
        await original(command, payload);
        throw new Error('The fixture lost the edit acknowledgement.');
      }
      return original(command, payload);
    };
  });
  await page.evaluate(({ projectId, sessionId }) => {
    localStorage.clear(); sessionStorage.clear();
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160;
    const context = canvas.getContext('2d'); context.fillStyle = '#287c4e'; context.fillRect(0, 0, 320, 160);
    context.fillStyle = '#fff'; context.font = '22px sans-serif'; context.fillText('Original attachment', 24, 85);
    const image = { type: 'image', mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] };
    const session = { id: sessionId, title: 'Edit sent messages', projectId, createdAt: 1, updatedAt: 1 };
    const message = (id, entryId, role, text) => ({ id, entryId, role, timestamp: 1000 * entryId,
      ...(role === 'assistant' ? { completed: true } : {}), blocks: [{ type: 'text', text }] });
    const messages = [message('intro', 2, 'user', '先检查项目结构。'), message('context', 3, 'assistant', 'Earlier context is preserved.'),
      { ...message('target', 4, 'user', 'Add the account page.'), blocks: [{ type: 'text', text: 'Add the account page.' }, image] },
      message('old-answer', 5, 'assistant', 'Original account page answer.'),
      message('tail', 6, 'user', 'Then check permissions.'), message('later-answer', 7, 'assistant', 'Later answer should not be replayed.')];
    localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, projectId, sessions: [session],
      views: { [sessionId]: { messages, status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'high' } }, parents: {} }));
    localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: sessionId }, navigation: true, reading: {}, reviewPaths: {} }));
  }, { projectId, sessionId });
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  const prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
  const intro = page.locator('[data-message-id="intro"]');
  const target = page.locator('[data-message-id="target"]');
  const editor = page.getByRole('textbox', { name: 'Edit sent message', exact: true });
  const form = page.getByRole('form', { name: 'Edit sent message', exact: true });
  const send = form.getByRole('button', { name: 'Send again', exact: true });
  const ordinary = 'Do not send this unsent draft.';
  await prompt.fill(ordinary);
  const actions = await target.locator('.message-footer button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  if (JSON.stringify(actions) !== JSON.stringify(['Copy message', 'Edit message'])) throw new Error('Edit must sit immediately beside Copy under committed user messages.');
  if (await page.locator('.chat-entry--assistant .message-edit').count()) throw new Error('Assistant messages must not expose user editing.');
  await target.getByRole('button', { name: 'Copy message', exact: true }).click();
  if (await page.locator('body').getAttribute('data-copied-text') !== 'Add the account page.') throw new Error('Copy changed while adding Edit.');
  await intro.getByRole('button', { name: 'Edit message', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.message-editor textarea')?.value === '先检查项目结构。');
  if (!await editor.evaluate(element => element === document.activeElement)) throw new Error('Opening an edit did not focus its text.');
  await editor.fill('  ');
  if (await send.isEnabled()) throw new Error('Empty text-only edits must not be submitted.');
  await editor.fill('IME 确认不会发送');
  await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  if (!await editor.isVisible()) throw new Error('IME confirmation sent the edited message.');
  await editor.press('Shift+Enter');
  if (!(await editor.inputValue()).includes('\n')) throw new Error('Shift+Enter must insert a newline.');
  await editor.press('Escape');
  await editor.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('[data-message-id="intro"] .message-edit') === document.activeElement);
  if (await prompt.inputValue() !== ordinary) throw new Error('Editing overwrote the ordinary draft.');

  await page.evaluate(() => sessionStorage.setItem('edit-reject-read', '1'));
  await target.getByRole('button', { name: 'Edit message', exact: true }).click();
  await form.getByRole('alert').getByText('The fixture could not load this message.', { exact: true }).waitFor();
  await page.evaluate(() => sessionStorage.removeItem('edit-reject-read'));
  await form.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-editor textarea')?.value === 'Add the account page.');
  await form.getByText('1 image attachment will be kept.', { exact: true }).waitFor();
  const revised = '改为添加账户设置页面。\n保留图片，重新执行验证。';
  await editor.fill(revised);
  for (const width of [1280, 720]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: theme })), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.colorMode === theme, theme);
    await form.scrollIntoViewIfNeeded();
    const geometry = await form.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const textarea = element.querySelector('textarea').getBoundingClientRect();
      return bounds.width >= 240 && bounds.left >= 0 && bounds.right <= innerWidth
        && textarea.width <= bounds.width && element.scrollWidth <= element.clientWidth;
    });
    if (!geometry) throw new Error('The inline message editor overflows the conversation.');
    await page.screenshot({ path: `output/playwright/pideck-message-edit-${width === 1280 ? theme : 'narrow-' + theme}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: 'dark' })));
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await target.getByText('Add the account page.', { exact: true }).waitFor();
  await target.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-editor textarea')?.readOnly === false);
  await editor.fill(revised);
  await page.evaluate(() => sessionStorage.setItem('edit-reject-send', '1'));
  await send.click();
  await form.getByRole('alert').getByText('The fixture rejected the edit.', { exact: true }).waitFor();
  if (await editor.inputValue() !== revised || await prompt.inputValue() !== ordinary) throw new Error('A rejected edit lost text or modified the parked draft.');
  await page.evaluate(() => sessionStorage.setItem('edit-lose-reply', '1'));
  await editor.press('Enter');
  await page.waitForFunction(() => typeof window.messageEditVerification.release === 'function');
  if (await form.getByRole('button', { name: 'Sending…', exact: true }).isEnabled()
    || await form.getByRole('button', { name: 'Cancel', exact: true }).isEnabled()) throw new Error('An in-flight edit must prevent duplicate sends and cancel.');
  await editor.press('Enter');
  await page.evaluate(() => window.messageEditVerification.release());
  await form.getByRole('alert').getByText('The fixture lost the edit acknowledgement.', { exact: true }).waitFor();
  await send.click();
  await editor.waitFor({ state: 'detached' });
  await page.getByText('Edited request executed again.', { exact: true }).waitFor();
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('pideck.workspace.v1')).sessions[JSON.parse(localStorage.getItem('pideck.workspace.v1')).projectId]);
  if (current === sessionId) throw new Error('The edited execution did not open its new session.');
  const editedText = await page.locator('.chat-thread').innerText();
  if (!editedText.includes(revised) || !editedText.includes('Earlier context is preserved.')
    || editedText.includes('Original account page answer.') || editedText.includes('Later answer should not be replayed.')
    || await page.locator('.chat-entry--user img').count() !== 1) throw new Error('Resending did not replace the selected turn and its old tail while keeping prior context and images.');
  const requests = await page.evaluate(() => window.messageEditVerification.calls.filter(call => call.command === 'chat:edit'));
  if (requests.length !== 3 || new Set(requests.map(call => call.payload.requestId)).size !== 1) throw new Error('Retries must reuse the same edit identity and prevent duplicate admission.');
  await page.screenshot({ path: 'output/playwright/pideck-message-edit-result.png' });
  await page.locator(`#nav-session-${sessionId}`).click();
  await target.getByText('Add the account page.', { exact: true }).waitFor();
  if (await prompt.inputValue() !== ordinary) throw new Error('The source session lost its ordinary draft.');
  await page.getByText('Later answer should not be replayed.', { exact: true }).waitFor();

  // An edit may be prepared while work is running; the existing Cancel run
  // control must stop it before a replacement can start touching the project.
  await page.evaluate(sessionId => {
    const state = JSON.parse(localStorage.getItem('pideck-browser-fixture'));
    state.views[sessionId].status = 'running';
    localStorage.setItem('pideck-browser-fixture', JSON.stringify(state));
  }, sessionId);
  await page.reload();
  await target.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-editor textarea')?.readOnly === false);
  await editor.fill('');
  await form.getByText('Stop the current run before resending.', { exact: true }).waitFor();
  if (await send.isEnabled()) throw new Error('An edited execution must not race the active source run.');
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.message-edit-actions button[type="submit"]')?.disabled);
  await send.click();
  await page.getByText('Edited request executed again.', { exact: true }).waitFor();
  if (await page.locator('.chat-entry--user img').count() !== 1) throw new Error('An image-only resend lost the original attachment.');

  await page.locator(`#nav-session-${sessionId}`).click();
  await intro.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.message-editor textarea')?.readOnly === false);
  await editor.fill('从第一条消息重新开始。');
  await editor.press('Enter');
  await page.getByText('Edited request executed again.', { exact: true }).waitFor();
  if (await page.locator('.chat-entry--user').count() !== 1 || (await page.locator('.chat-thread').innerText()).includes('Earlier context is preserved.')) {
    throw new Error('Editing the first message inherited an old turn.');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Message edit flow passed: adjacent action, full content, cancel/focus, IME/newlines, failed reads/sends, idempotent retries, native-context resend, images, first message, and active-run guard.');
}
