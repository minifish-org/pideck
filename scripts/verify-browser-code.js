async page => {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const projectId = 'c23c2a0c-6fdd-435a-8a0c-f5d6ff433601';
  const sessionId = '6253dab2-0cb1-45eb-99f4-0c4d68b8029b';
  const source = 'const payload = "<img src=x onerror=alert(1)>";\nconsole.log(payload);\n';
  const markdown = `## 审阅代码 / Code review\n\n检查 **更新流程** 和 *keyboard focus*。Inline \`plainInline\` and ***\`highlightedInline\`*** both stay inline.\n\n\`\`\`typescript\n${source}\`\`\`\n\n\`\`\`unknown-audit-language\nunknown <tag> & text\n\`\`\`\n\n\`\`\`\nplain block\n\`\`\``;
  const previous = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  await page.addInitScript(() => {
    if (!localStorage.getItem('pideck-code-audit')) return;
    function instrument(api) {
    const listeners = new Set();
    const latest = new Map();
    let failCopy = false;
    const invoke = api.invoke;
    const subscribe = api.onEvent;
    api.invoke = (command, payload) => {
      if (command === 'clipboard:write' && failCopy) return Promise.reject(new Error('Clipboard unavailable.'));
      return invoke(command, payload);
    };
    api.onEvent = listener => {
      listeners.add(listener);
      const unsubscribe = subscribe(event => {
        if (event.type === 'chat:update' && event.view) latest.set(event.subscriptionId, event);
        listener(event);
      });
      return () => { listeners.delete(listener); unsubscribe(); latest.clear(); };
    };
    window.__pideckCodeAudit = {
      copyFailure(value) { failCopy = value; },
      stream(text) {
        for (const [id, event] of latest) {
          const next = { ...event, sequence: event.sequence + 1,
            view: { ...event.view, messages: event.view.messages.map(message => message.role === 'assistant'
              ? { ...message, blocks: [{ type: 'text', text }] } : message) } };
          latest.set(id, next);
          for (const listener of listeners) listener(next);
        }
      },
    };
    return api;
    }
    // Init script ordering is unspecified; wrap the fixture bridge whether it
    // has already been created or is assigned by its own init script later.
    if (window.pideck) instrument(window.pideck);
    else {
      let bridge;
      Object.defineProperty(window, 'pideck', { configurable: true,
        get() { return bridge; }, set(value) { bridge = instrument(value); } });
    }
  });
  try {
    await page.evaluate(({ projectId, sessionId, markdown }) => {
      localStorage.clear();
      localStorage.setItem('pideck-code-audit', 'true');
      localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: sessionId }, navigation: true, reading: {}, reviewPaths: {} }));
      localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, projectId, mainSessionId: sessionId,
        sessions: [{ id: sessionId, projectId, title: 'Code block review', createdAt: 1, updatedAt: 1 }], parents: {},
        views: { [sessionId]: { status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'off', messages: [
          { id: '1:0', entryId: 1, role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Review code blocks.' }] },
          { id: '3:0', entryId: 3, role: 'assistant', timestamp: 2, completed: true, blocks: [{ type: 'text', text: markdown }] },
        ] } } }));
    }, { projectId, sessionId, markdown });
    await page.reload();
    const code = page.locator('.markdown-code-block').first();
    const pre = code.locator('pre');
    await page.waitForFunction(() => document.querySelector('.markdown-code-block pre')?.dataset.highlighted === 'dark');
    if (await pre.textContent() !== source || await code.locator('pre code span[style]').count() < 2) throw new Error('Code highlighting changed the source or failed to create colored tokens.');
    const typography = await page.evaluate(() => {
      const paragraph = getComputedStyle(document.querySelector('.markdown > p'));
      const heading = getComputedStyle(document.querySelector('.markdown h2'));
      const emphasis = getComputedStyle(document.querySelector('.markdown em code'));
      const block = getComputedStyle(document.querySelector('.markdown-code-block pre'));
      const blockCode = getComputedStyle(document.querySelector('.markdown-code-block pre > code'));
      return {
        heading: parseFloat(heading.fontSize) > parseFloat(paragraph.fontSize),
        composer: getComputedStyle(document.getElementById('prompt')).fontSize === paragraph.fontSize,
        emphasis: emphasis.fontStyle === 'italic' && Number(emphasis.fontWeight) > Number(paragraph.fontWeight),
        code: blockCode.fontSize === block.fontSize && blockCode.fontFamily === block.fontFamily && emphasis.fontFamily === block.fontFamily,
      };
    });
    if (Object.values(typography).some(passed => !passed)) throw new Error(`Conversation typography did not apply: ${JSON.stringify(typography)}`);
    await page.screenshot({ path: 'output/playwright/pideck-code-dark.png' });
    if (await page.locator('.markdown p > code').textContent() !== 'plainInline' || await page.locator('.markdown-code-block').count() !== 3) throw new Error('Inline code or unlabelled blocks changed.');
    if (await page.locator('.markdown img').count()) throw new Error('Code text was rendered as markup.');
    if (await page.locator('.markdown-code-block').nth(1).locator('pre').textContent() !== 'unknown <tag> & text\n') throw new Error('Unknown code languages must remain readable plain text.');
    const copy = code.getByRole('button', { name: 'Copy code block', exact: true });
    await copy.focus();
    await copy.press('Enter');
    await code.getByRole('button', { name: 'Code copied', exact: true }).waitFor();
    if (await page.locator('body').getAttribute('data-copied-text') !== source) throw new Error('Code copy included language labels, surrounding Markdown or changed whitespace.');
    await page.evaluate(() => window.__pideckCodeAudit.copyFailure(true));
    await code.getByRole('button', { name: /^(Copy code block|Code copied)$/ }).click();
    await code.getByRole('alert').getByText('Couldn’t copy code. Try again.').waitFor();
    await page.evaluate(() => window.__pideckCodeAudit.copyFailure(false));
    await code.getByRole('button', { name: /^(Copy code block|Code copied)$/ }).click();
    await code.getByRole('button', { name: 'Code copied', exact: true }).waitFor();
    if (await code.getByRole('alert').count()) throw new Error('Successful code copy left a stale clipboard error.');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: 'light' })));
    await page.waitForFunction(() => document.querySelector('.markdown-code-block pre')?.dataset.highlighted === 'light');
    await page.screenshot({ path: 'output/playwright/pideck-code-light.png' });
    await page.evaluate(() => {
      window.__pideckCodeAudit.stream('```python\nold = 1\n```');
      setTimeout(() => window.__pideckCodeAudit.stream('```javascript\nconst newest = 2;\n```'), 70);
    });
    await page.waitForFunction(() => {
      const pre = document.querySelector('.markdown-code-block pre');
      return pre?.dataset.highlighted === 'light' && pre.textContent === 'const newest = 2;\n';
    });
    await page.waitForTimeout(200);
    if (await pre.textContent() !== 'const newest = 2;\n') throw new Error('A stale async grammar load replaced newer streamed code.');
    if (errors.length) throw new Error(errors.join('\n'));
    return 'Code block flow passed: highlighting, theme changes, exact keyboard copy, clipboard recovery, safe text, inline/plain code and streaming.';
  } finally {
    await page.evaluate(previous => { localStorage.clear(); for (const [key, value] of Object.entries(previous)) localStorage.setItem(key, value); }, previous);
    await page.reload();
    page.off('pageerror', onError);
  }
}
