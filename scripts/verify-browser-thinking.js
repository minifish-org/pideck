async page => {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const projectId = '74de4c42-3a46-4430-873c-9bcb42fdb287';
  const sessionId = '2dd96030-16c4-4319-9a8b-6a10258dbf82';
  const previous = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const viewport = page.viewportSize();
  const model = page.getByRole('button', { name: 'Model', exact: true });
  const slider = page.getByRole('slider', { name: 'Thinking level' });
  const newSession = page.getByRole('button', { name: 'New session in Sample project', exact: true });
  const existingSession = page.locator(`#nav-session-${sessionId}`);
  async function expectThinking(level) {
    await model.click();
    await slider.waitFor();
    const actual = await slider.getAttribute('aria-valuetext');
    if (actual !== level) throw new Error(`Expected thinking ${level}, received ${actual}.`);
  }
  async function closePicker() {
    await slider.press('Escape');
  }
  try {
    await page.evaluate(({ projectId, sessionId }) => {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: sessionId }, navigation: true }));
      localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, projectId,
        sessions: [{ id: sessionId, projectId, title: 'Keep the existing High setting', createdAt: 1, updatedAt: 1 }], parents: {},
        views: { [sessionId]: { status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'high', messages: [
          { id: 'user', entryId: 2, role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Keep this session on High.' }] },
          { id: 'answer', entryId: 3, role: 'assistant', completed: true, timestamp: 2, blocks: [{ type: 'text', text: 'Ready for another request.' }] },
        ] } } }));
    }, { projectId, sessionId });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await existingSession.waitFor();
    await expectThinking('High');
    await closePicker();

    // Choose a project preference in a different conversation. The existing
    // conversation must not acquire a draft override while we inspect it.
    await newSession.click();
    await model.click();
    await slider.fill('1'); // The fixture supports Off, Low and High.
    if (await slider.getAttribute('aria-valuetext') !== 'Low') throw new Error('The thinking slider did not select Low.');
    await closePicker();
    if (await page.evaluate(projectId => localStorage.getItem(`pideck.thinking.v1/${projectId}`), projectId) !== 'low') {
      throw new Error('The manual choice was not saved as the project preference.');
    }
    await page.getByRole('textbox', { name: 'Message Pideck', exact: true }).fill('Start with project Low.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('pideck-browser-fixture')).sessions.length === 2);
    const startedId = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pideck-browser-fixture'));
      const started = state.sessions.find(session => session.title === 'Start with project Low.');
      if (state.views[started.id].thinking !== 'low') throw new Error('The first message did not submit the selected Low level.');
      window.dispatchEvent(new Event('pideck-fixture-finish-start'));
      return started.id;
    });
    await page.locator(`#nav-session-${startedId}[aria-current="true"]`).waitFor();

    await existingSession.click();
    await expectThinking('High');
    await closePicker();
    await page.reload();
    await expectThinking('High');
    await page.screenshot({ path: 'output/playwright/pideck-thinking-existing-session.png' });
    await closePicker();

    // Sending consumed the first draft. This is a genuinely new composer, so
    // Low must come from the project preference, not a retained draft choice.
    await newSession.click();
    if (await page.evaluate(projectId => localStorage.getItem(`pideck.draft.v1/${projectId}/draft`), projectId) !== null) {
      throw new Error('The first message left a draft behind and would mask project inheritance.');
    }
    await expectThinking('Low');
    await closePicker();
    await page.reload();
    await expectThinking('Low');
    await page.screenshot({ path: 'output/playwright/pideck-thinking-new-session.png' });
    await closePicker();
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('pideck-browser-fixture')));
    if (state.views[sessionId].thinking !== 'high' || state.sessions.length !== 2) {
      throw new Error('Inspecting thinking settings changed the existing session or created an empty session.');
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return 'Thinking preference flow passed: manual project Low persists, existing session stays High, first send uses Low, and a fresh draft inherits Low across reloads.';
  } finally {
    await page.evaluate(previous => {
      localStorage.clear(); sessionStorage.clear();
      for (const [key, value] of Object.entries(previous.local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(previous.session)) sessionStorage.setItem(key, value);
    }, previous);
    if (viewport) await page.setViewportSize(viewport);
    await page.reload();
    page.off('pageerror', onError);
  }
}
