async page => {
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const projectId = '74de4c42-3a46-4430-873c-9bcb42fdb287';
  const sessionId = '5dd96030-16c4-4319-9a8b-6a10258dbf82';
  const otherId = '6dd96030-16c4-4319-9a8b-6a10258dbf82';
  await page.addInitScript(() => {
    if (!window.pideck) return;
    const original = window.pideck;
    const listeners = new Set();
    const calls = [];
    window.attachmentVerification = { calls, emit: event => { for (const listener of listeners) listener(event); } };
    window.pideck = { ...original,
      onEvent(listener) {
        listeners.add(listener);
        const stop = original.onEvent(listener);
        return () => { listeners.delete(listener); stop(); };
      },
      async invoke(command, payload) {
        calls.push({ command, payload });
        if (command === 'chat:image') {
          if (sessionStorage.getItem('attachment-history-failure')) {
            sessionStorage.removeItem('attachment-history-failure');
            throw new Error('Image retrieval temporarily failed.');
          }
          if (payload.projectId !== '74de4c42-3a46-4430-873c-9bcb42fdb287'
            || payload.sessionId !== '5dd96030-16c4-4319-9a8b-6a10258dbf82'
            || ![10, 12].includes(payload.entryId) || payload.messageIndex !== 0 || payload.contentIndex !== 1) {
            throw new Error('Historical image retrieval lost its conversation or content coordinates.');
          }
          return { mimeType: 'image/png', data: sessionStorage.getItem('attachment-history-source') };
        }
        if (command === 'chat:send' && sessionStorage.getItem('attachment-reject-send')) {
          sessionStorage.removeItem('attachment-reject-send');
          throw new Error('The fixture rejected the image request.');
        }
        if (command === 'chat:queue-edit-finish' && sessionStorage.getItem('attachment-reject-save')) {
          sessionStorage.removeItem('attachment-reject-save');
          throw new Error('The fixture rejected the queue edit.');
        }
        return original.invoke(command, payload);
      },
    };
  });
  await page.evaluate(({ projectId, sessionId, otherId }) => {
    localStorage.clear(); sessionStorage.clear();
    const model = { provider: 'openai', id: 'fixture' };
    const sessions = [[sessionId, 'Attachment verification'], [otherId, 'Other attachment session']].map(([id, title]) =>
      ({ id, title, projectId, createdAt: 1, updatedAt: 1 }));
    const view = { status: 'running', model, thinking: 'high', canSteerQueued: true,
      messages: [{ id: 'prompt', entryId: 2, role: 'user', blocks: [{ type: 'text', text: 'Verify the screenshots while work continues.' }] }] };
    localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, projectId, sessions,
      views: { [sessionId]: view, [otherId]: { ...view, status: 'idle', messages: [] } }, parents: {} }));
    localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: sessionId },
      navigation: true, reading: {}, reviewPaths: {} }));
  }, { projectId, sessionId, otherId });
  await page.reload();
  await page.setViewportSize({ width: 1120, height: 800 });
  const prompt = page.getByRole('textbox', { name: 'Message Pideck', exact: true });
  const editor = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
  const composer = page.locator('form.composer');
  const queue = page.getByRole('list', { name: 'Queued messages', exact: true });
  const normalImages = composer.getByRole('group', { name: 'Message attachments', exact: true });
  const queuedImages = composer.getByRole('group', { name: 'Queued message attachments', exact: true });
  const save = page.getByRole('button', { name: 'Save queued message', exact: true });
  const preview = page.getByRole('dialog', { name: 'Image preview', exact: true });
  await prompt.waitFor();

  const sources = await page.evaluate(() => ['#a63d40', '#287c4e', '#316baa'].map((color, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#ffffff'; context.font = '24px sans-serif';
    context.fillText(index === 2 ? 'Ordinary draft' : `Queued screenshot ${index + 1}`, 24, 96);
    return canvas.toDataURL('image/png');
  }));
  const attach = async (source, name) => {
    await composer.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
    await page.waitForFunction(() => !document.querySelector('.composer-attach')?.disabled);
  };
  const expectImages = async (group, expected) => {
    await group.waitFor();
    await group.locator('img').last().waitFor();
    const actual = await group.locator('img').evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => image.src);
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('The editor displayed missing, reordered, or another draft\'s images.');
  };
  const expectEditor = async (text, expected) => {
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('#prompt')?.readOnly === false);
    if (await editor.inputValue() !== text) throw new Error('Restoring attachment previews replaced the edited text.');
    await expectImages(queuedImages, expected);
    if (await normalImages.count() || await composer.getByRole('button', { name: /^Remove attached image/ }).count()) {
      throw new Error('Queue editing exposed parked draft images or an unsupported attachment removal action.');
    }
    if (!await save.isEnabled()) throw new Error('A loaded queue edit with images must be saveable.');
  };
  const queueNext = page.getByRole('button', { name: 'Queue next', exact: true });
  const original = 'Queued request with screenshots.';
  await prompt.fill(original);
  await attach(sources[0], 'first.png');
  await attach(sources[1], 'second.png');
  await expectImages(normalImages, sources.slice(0, 2));
  await page.evaluate(() => sessionStorage.setItem('attachment-reject-send', '1'));
  await queueNext.click();
  await page.getByRole('alert').getByText('The fixture rejected the image request.', { exact: true }).waitFor();
  await expectImages(normalImages, sources.slice(0, 2));
  await page.locator(`#nav-session-${otherId}`).click();
  await page.locator(`#nav-session-${sessionId}`).click();
  await expectImages(normalImages, sources.slice(0, 2));
  await page.reload();
  await expectImages(normalImages, sources.slice(0, 2));
  if (await prompt.inputValue() !== original) throw new Error('A rejected send lost its recoverable text.');
  await queueNext.click();
  const textRow = queue.getByRole('listitem').filter({ hasText: original });
  await textRow.waitFor();
  const textId = await textRow.getAttribute('data-queue-id');
  await normalImages.waitFor({ state: 'detached' });

  await attach(sources[1], 'image-only.png');
  await queueNext.click();
  await page.waitForFunction(() => document.querySelectorAll('.queued-list li').length === 2);
  const imageId = await queue.getByRole('listitem').last().getAttribute('data-queue-id');
  const ordinaryText = 'Keep this ordinary draft and its own screenshot.';
  await prompt.fill(ordinaryText);
  await attach(sources[2], 'ordinary.png');
  const ordinaryKey = `pideck.draft.v1/${projectId}/${sessionId}`;
  await textRow.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expectEditor(original, sources.slice(0, 2));
  const thumbnail = queuedImages.getByRole('button', { name: 'Preview attached image 1', exact: true });
  await thumbnail.click();
  await preview.waitFor();
  if (await preview.locator('img').getAttribute('src') !== sources[0]) throw new Error('The queue preview opened a different image.');
  await page.screenshot({ path: 'output/playwright/pideck-attachments-preview.png' });
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  if (!await thumbnail.evaluate(button => button === document.activeElement)) throw new Error('Closing the queue preview lost keyboard focus.');

  const revised = 'Revised request; keep both screenshots.';
  await editor.fill(revised);
  await page.screenshot({ path: 'output/playwright/pideck-attachments-dark.png' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: 'light' })));
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === 'light');
  await page.screenshot({ path: 'output/playwright/pideck-attachments-light.png' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: 'dark' })));
  await page.setViewportSize({ width: 760, height: 560 });
  await save.hover();
  await composer.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: 'output/playwright/pideck-attachments-narrow.png' });
  if (!await composer.evaluate(form => {
    const bounds = form.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
  })) throw new Error('The queue editor or its attachments overflow the narrow window.');
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.locator(`#nav-session-${otherId}`).click();
  await prompt.waitFor();
  if (await composer.locator('.attachments').count()) throw new Error('Switching sessions leaked queue attachments.');
  await page.locator(`#nav-session-${sessionId}`).click();
  await expectEditor(revised, sources.slice(0, 2));
  await page.evaluate(() => window.attachmentVerification.emit({ type: 'host:disconnected', message: 'Attachment recovery check.' }));
  await page.waitForFunction(() => document.querySelector('#prompt')?.readOnly === true);
  await page.evaluate(() => window.attachmentVerification.emit({ type: 'host:restart' }));
  await expectEditor(revised, sources.slice(0, 2));
  await page.reload();
  await expectEditor(revised, sources.slice(0, 2));
  const url = page.url();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('about:blank');
  await page.goto(url);
  await expectEditor(revised, sources.slice(0, 2));
  const saved = await page.evaluate(key => localStorage.getItem(key), ordinaryKey);
  if (sources.some(source => saved.includes(source.split(',')[1]))) throw new Error('Queue previews embedded image data in persisted browser drafts.');
  await page.evaluate(() => sessionStorage.setItem('attachment-reject-save', '1'));
  await save.click();
  await page.getByRole('alert').getByText('The fixture rejected the queue edit.', { exact: true }).waitFor();
  await expectEditor(revised, sources.slice(0, 2));
  await save.click();
  await prompt.waitFor();
  if (await prompt.inputValue() !== ordinaryText) throw new Error('Saving the queue edit replaced the parked ordinary draft.');
  await expectImages(normalImages, [sources[2]]);
  const finish = await page.evaluate(() => window.attachmentVerification.calls.filter(call => call.command === 'chat:queue-edit-finish').at(-1));
  if ('images' in finish.payload || finish.payload.text !== revised) throw new Error('Saving an edit resubmitted or replaced original image attachments.');

  const imageRow = queue.locator(`[data-queue-id="${imageId}"]`);
  await imageRow.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expectEditor('', [sources[1]]);
  await editor.fill('Discard this temporary text.');
  await editor.press('Escape');
  await prompt.waitFor();
  await expectImages(normalImages, [sources[2]]);
  await imageRow.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expectEditor('', [sources[1]]);
  await save.click();
  await prompt.waitFor();
  await expectImages(normalImages, [sources[2]]);

  await page.evaluate(() => sessionStorage.setItem('pideck-fail-edit-start', '1'));
  await queue.locator(`[data-queue-id="${textId}"]`).getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.getByRole('button', { name: 'Retry queue edit', exact: true }).waitFor();
  if (await composer.locator('.attachments').count()) throw new Error('A lost edit acknowledgement displayed a different draft\'s images.');
  await page.getByRole('button', { name: 'Retry queue edit', exact: true }).click();
  await expectEditor(revised, sources.slice(0, 2));
  await editor.press('Escape');
  await prompt.waitFor();
  await expectImages(normalImages, [sources[2]]);
  await page.reload();
  await expectImages(normalImages, [sources[2]]);
  if (await prompt.inputValue() !== ordinaryText) throw new Error('Cancelling and reopening lost the ordinary draft.');
  await page.evaluate(source => {
    sessionStorage.setItem('attachment-history-source', source.split(',')[1]);
    sessionStorage.setItem('attachment-history-failure', '1');
    const state = JSON.parse(localStorage.getItem('pideck-browser-fixture'));
    const view = state.views['5dd96030-16c4-4319-9a8b-6a10258dbf82'];
    view.status = 'idle'; delete view.queued;
    view.messages = [
      { id: '10:0', entryId: 10, role: 'user', blocks: [{ type: 'image', mimeType: 'image/png', data: '',
        ref: { entryId: 10, messageIndex: 0, contentIndex: 1 } }] },
      { id: '11:0', entryId: 11, role: 'assistant', blocks: [{ type: 'tool', id: 'historical-read', name: 'read', status: 'done',
        path: 'screenshot.png', images: [{ mimeType: 'image/png', data: '', ref: { entryId: 12, messageIndex: 0, contentIndex: 1 } }] }] },
    ];
    localStorage.setItem('pideck-browser-fixture', JSON.stringify(state));
  }, sources[0]);
  await page.reload();
  const earlierImage = page.getByRole('button', { name: 'Preview attached image', exact: true });
  await earlierImage.click();
  await page.getByRole('alert').getByText('Image retrieval temporarily failed.', { exact: true }).waitFor();
  await earlierImage.click();
  await preview.waitFor();
  await preview.locator('img').evaluate(image => image.decode());
  if (await preview.locator('img').getAttribute('src') !== sources[0]) throw new Error('Historical image preview loaded the wrong data.');
  await preview.press('Escape');
  if (await page.getByText('Image retrieval temporarily failed.', { exact: true }).count()) throw new Error('Retry left a stale image error.');
  await page.locator('.tool-card summary').click();
  await page.getByRole('button', { name: 'Preview output from read', exact: true }).click();
  await preview.waitFor();
  await preview.locator('img').evaluate(image => image.decode());
  await page.screenshot({ path: 'output/playwright/pideck-attachments-history.png' });
  await preview.press('Escape');
  if (await page.locator('.chat-thread img').count()) throw new Error('Previewing an earlier image must not expand the live transcript payload.');
  if (errors.length) throw new Error(errors.join('\n'));
  return 'Attachment flow passed: queue thumbnails and full preview, image-only edits, save/cancel isolation, rejected sends/saves, session switching, watch reconnection, renderer/window recovery, lost edit acknowledgements and on-demand historical user/tool images with retry.';
}
