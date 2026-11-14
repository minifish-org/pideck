async page => {
  const errors = [];
  const remote = [];
  const onError = error => errors.push(error.message);
  const onRequest = request => { if (request.url().includes('untrusted.invalid')) remote.push(request.url()); };
  page.on('pageerror', onError); page.on('request', onRequest);
  const previous = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  const projectId = '35771bb4-0466-4110-8c1c-2aad53c68687';
  const sessionId = 'fe8a8df0-ae45-447d-9d13-8b0c634ca98b';
  const code = Array.from({ length: 32 }, (_, index) => `export const step${index + 1} = "${index === 3 ? 'a long value '.repeat(20) : `verified ${index + 1}`}";`).join('\n') + '\n';
  const patch = 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const state = "old";\n+export const state = "verified";\n';
  const graph = 'flowchart LR\n  Inspect[Inspect project] --> Edit[Edit source]\n  Edit --> Review{Review changes}\n  Review --> Verify[Verify in browser]\n';
  const markdown = `## Reply rendering / 回复渲染\n\nThe screenshot is now part of the reply.[^1] [Jump to code](#code)\n\n> [!NOTE]\n> Images are loaded from this conversation, not from remote websites.\n\n![Verified UI screenshot](output/verified.png)\n\n### Results\n\n| Feature | Status | Notes |\n| :--- | :---: | ---: |\n| Images | **Ready** | Click to zoom |\n| Code | Ready | Preserves source |\n| Tables | Ready | Copy TSV or CSV |\n\n### Code\n\n\`\`\`typescript filename="src/steps.ts"\n${code}\`\`\`\n\n### Proposed patch\n\n\`\`\`diff\n${patch}\`\`\`\n\n### Workflow\n\n\`\`\`mermaid\n${graph}\`\`\`\n\n<details>\n<summary>Verification details</summary>\n\nAll checks are **read-only** in this reply.\n\n</details>\n\n[^1]: This is an immutable screenshot captured by the read tool.`;
  await page.addInitScript(() => {
    if (!localStorage.getItem('pideck-reply-audit')) return;
    function instrument(api) {
      const invoke = api.invoke;
      const subscribe = api.onEvent;
      const latest = new Map();
      const listeners = new Set();
      const calls = [];
      const cancelled = [];
      let failImage = true;
      let holdImage;
      api.invoke = async (command, payload) => {
        if (command === 'chat:reply-image') {
          calls.push(payload);
          if (payload.href === 'retry.png' && failImage) { failImage = false; throw new Error('Image temporarily unavailable.'); }
          if (['slow.png', 'delayed.png', 'bottom.png'].includes(payload.href)) return new Promise(resolve => { holdImage = () => resolve({ mimeType: 'image/png', data: localStorage.getItem('pideck-reply-source'), source: 'file' }); });
          if (payload.href !== 'output/verified.png' && payload.href !== 'retry.png') throw new Error('Image unavailable in this project.');
          return { mimeType: 'image/png', data: localStorage.getItem('pideck-reply-source'), source: 'conversation' };
        }
        if (command === 'chat:reply-image-cancel') { cancelled.push(payload); return; }
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
      window.__pideckReplyAudit = {
        calls, cancelled, releaseImage() { holdImage?.(); },
        text(text, streaming = false) {
          for (const [id, event] of latest) {
            const next = { ...event, sequence: event.sequence + 1, view: { ...event.view, status: streaming ? 'running' : 'idle',
              messages: event.view.messages.map((message, index) => index !== 1 ? message : { ...message,
                id: streaming ? 'live-assistant' : '3:0', entryId: streaming ? undefined : 3, completed: streaming ? undefined : true,
                blocks: [{ type: 'text', text }] }) } };
            latest.set(id, next);
            for (const listener of listeners) listener(next);
          }
        },
      };
      return api;
    }
    if (window.pideck) instrument(window.pideck);
    else { let bridge; Object.defineProperty(window, 'pideck', { configurable: true, get() { return bridge; }, set(value) { bridge = instrument(value); } }); }
  });
  try {
    await page.evaluate(({ projectId, sessionId, markdown }) => {
      localStorage.clear(); localStorage.setItem('pideck-reply-audit', 'true');
      const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 900;
      const context = canvas.getContext('2d');
      context.fillStyle = '#161b22'; context.fillRect(0, 0, 1440, 900);
      context.fillStyle = '#30363d'; context.fillRect(0, 0, 1440, 64);
      context.fillStyle = '#238636'; context.fillRect(80, 120, 1280, 100);
      context.fillStyle = '#f0f6fc'; context.font = 'bold 38px sans-serif'; context.fillText('Verified UI screenshot', 110, 184);
      context.font = '26px sans-serif'; context.fillText('Local image · saved in conversation', 110, 300);
      for (let index = 0; index < 4; index++) { context.fillStyle = index % 2 ? '#21262d' : '#30363d'; context.fillRect(110, 360 + index * 90, 1200, 66); }
      localStorage.setItem('pideck-reply-source', canvas.toDataURL('image/png').split(',')[1]);
      localStorage.setItem('pideck.workspace.v1', JSON.stringify({ projectId, sessions: { [projectId]: sessionId }, navigation: true, reading: {}, reviewPaths: {} }));
      localStorage.setItem('pideck-browser-fixture', JSON.stringify({ opened: true, configured: true, appearance: 'dark', projectId, mainSessionId: sessionId,
        sessions: [{ id: sessionId, projectId, title: 'Rich reply review', createdAt: 1, updatedAt: 1 }], parents: {},
        views: { [sessionId]: { status: 'idle', model: { provider: 'openai', id: 'fixture' }, thinking: 'off', messages: [
          { id: '1:0', entryId: 1, role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Review the screenshot, code and verification results.' }] },
          { id: '3:0', entryId: 3, role: 'assistant', timestamp: 2, completed: true, blocks: [{ type: 'text', text: markdown }] },
          { id: '5:0', entryId: 5, role: 'assistant', timestamp: 3, completed: true, blocks: [{ type: 'text', text: '## Reply rendering / 回复渲染\n\nAnother reply with the same footnote.[^1] Unicode works too.[^脚注]\n\n[^1]: Must stay in this reply.\n[^脚注]: Unicode reference.' }] },
        ] } } }));
    }, { projectId, sessionId, markdown });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
    const reply = page.locator('[data-message-id="3:0"]');
    await reply.locator('h2').first().waitFor();
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
    const screenshot = reply.getByRole('button', { name: 'Preview Verified UI screenshot', exact: true });
    await screenshot.waitFor(); await screenshot.locator('img').evaluate(image => image.decode());
    await page.screenshot({ path: 'output/playwright/pideck-replies-dark.png' });
    const ids = await page.locator('.markdown [id]').evaluateAll(elements => elements.map(element => element.id));
    if (ids.length !== new Set(ids).size) throw new Error('Markdown IDs collide between replies.');
    const firstFootnote = reply.locator('a[data-footnote-ref]').first();
    await firstFootnote.click();
    if (!await reply.locator('.footnotes li').evaluate(element => element === document.activeElement)) throw new Error('Footnote did not focus its own target.');
    await reply.locator('a[data-footnote-backref]').click();
    if (!await firstFootnote.evaluate(element => element === document.activeElement)) throw new Error('Footnote backlink lost its reference.');
    const unicodeNote = page.locator('[data-message-id="5:0"] a[data-footnote-ref]').last();
    const unicodeTarget = decodeURIComponent((await unicodeNote.getAttribute('href')).slice(1));
    await unicodeNote.click();
    if (await page.evaluate(() => document.activeElement?.id) !== unicodeTarget) throw new Error('Unicode footnote could not reach its scoped ID.');
    await reply.getByRole('link', { name: 'Jump to code', exact: true }).click();
    if (!await reply.locator('h3').filter({ hasText: /^Code/ }).evaluate(element => element === document.activeElement)) throw new Error('Heading anchor did not jump within the reply.');

    const table = reply.locator('.markdown-table');
    await table.getByRole('button', { name: 'Copy CSV', exact: true }).click();
    if (await page.locator('body').getAttribute('data-copied-text') !== 'Feature,Status,Notes\nImages,Ready,Click to zoom\nCode,Ready,Preserves source\nTables,Ready,Copy TSV or CSV') throw new Error('CSV copy changed table cell contents.');
    await table.getByRole('button', { name: 'Expand table', exact: true }).click();
    const tablePreview = page.getByRole('dialog', { name: 'Table preview', exact: true });
    await tablePreview.getByRole('button', { name: 'Copy TSV', exact: true }).click();
    if (!(await page.locator('body').getAttribute('data-copied-text')).startsWith('Feature\tStatus\tNotes\n')) throw new Error('Expanded table could not copy TSV.');
    await tablePreview.press('Escape');
    if (!await table.getByRole('button', { name: 'Expand table', exact: true }).evaluate(element => element === document.activeElement)) throw new Error('Table preview did not restore focus.');

    const sourceBlock = reply.locator('.markdown-code-block').filter({ hasText: 'src/steps.ts' });
    await sourceBlock.getByRole('button', { name: 'Wrap code', exact: true }).click();
    await sourceBlock.getByRole('button', { name: 'Show all 32 lines', exact: true }).click();
    if (await sourceBlock.locator('pre').textContent() !== code) throw new Error('Code controls changed the source.');
    await sourceBlock.getByRole('button', { name: 'Copy code block', exact: true }).click();
    if (await page.locator('body').getAttribute('data-copied-text') !== code) throw new Error('Code copy included presentation metadata.');
    await sourceBlock.getByRole('button', { name: 'Collapse code', exact: true }).click();

    const diff = reply.locator('.markdown-code-block').filter({ hasText: 'Proposed · not applied' });
    await diff.locator('diffs-container').waitFor();
    await diff.getByRole('button', { name: 'Split diff', exact: true }).click();
    await diff.getByRole('button', { name: 'Show source', exact: true }).click();
    if (await diff.locator('pre').textContent() !== patch) throw new Error('Proposed diff source changed.');
    await diff.getByRole('button', { name: 'Show diff', exact: true }).click();
    const diagram = reply.getByRole('button', { name: 'Expand Mermaid diagram', exact: true });
    await reply.locator('.markdown-diagram').scrollIntoViewIfNeeded();
    await diagram.waitFor({ timeout: 60000 }); await diagram.locator('img').evaluate(image => image.decode());
    const darkDiagram = await diagram.locator('img').getAttribute('src');
    await diagram.click();
    const preview = page.getByRole('dialog', { name: 'Image preview', exact: true });
    await preview.locator('img').evaluate(image => image.decode()); await preview.press('Escape');
    await reply.locator('summary').getByText('Verification details', { exact: true }).click();
    await reply.getByText('All checks are', { exact: false }).waitFor();
    await page.screenshot({ path: 'output/playwright/pideck-replies-diagram.png' });

    await screenshot.click(); await preview.locator('img').evaluate(image => image.decode());
    await preview.press('1');
    await preview.getByRole('button', { name: 'Zoom in', exact: true }).click();
    if (await preview.locator('.preview-zoom').textContent() !== '125%') throw new Error('Zoom controls did not preserve actual scale.');
    const viewport = preview.locator('.image-preview-viewport');
    const bounds = await viewport.boundingBox();
    await page.mouse.move(bounds.x + 300, bounds.y + 250); await page.mouse.down(); await page.mouse.move(bounds.x + 100, bounds.y + 100); await page.mouse.up();
    if (!await viewport.evaluate(element => element.scrollLeft > 0 && element.scrollTop > 0)) throw new Error('Image panning did not move the zoomed canvas.');
    await page.screenshot({ path: 'output/playwright/pideck-replies-preview.png' });
    await preview.press('0');
    if (await preview.locator('.preview-zoom').textContent() === '125%') throw new Error('Fit-image keyboard shortcut was ignored.');
    await preview.press('Escape');
    if (!await screenshot.evaluate(element => element === document.activeElement)) throw new Error('Image preview did not restore focus.');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-appearance', { detail: 'light' })));
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: 'output/playwright/pideck-replies-light.png' });
    await reply.locator('.markdown-diagram').scrollIntoViewIfNeeded();
    await page.waitForFunction(source => { const image = document.querySelector('.markdown-diagram img'); return image?.getAttribute('src') && image.getAttribute('src') !== source; }, darkDiagram);
    await diagram.locator('img').evaluate(image => image.decode());
    await page.screenshot({ path: 'output/playwright/pideck-replies-light-diagram.png' });
    await page.setViewportSize({ width: 650, height: 900 });
    await sourceBlock.scrollIntoViewIfNeeded();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Rich replies overflow the window.');
    await page.screenshot({ path: 'output/playwright/pideck-replies-narrow.png' });

    // A late image above the visible text must not move the user's reading
    // position; a late image at the end must still follow a pinned transcript.
    const paragraph = 'Reading position stays stable while the screenshot loads. '.repeat(3);
    await page.evaluate(text => window.__pideckReplyAudit.text(text), '![Delayed](delayed.png)\n\n' + `${paragraph}\n\n`.repeat(8) + '### Reading marker\n\n' + `${paragraph}\n\n`.repeat(20));
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.waitForFunction(() => window.__pideckReplyAudit.calls.some(call => call.href === 'delayed.png'));
    const marker = reply.getByRole('heading', { name: /Reading marker/ });
    await marker.scrollIntoViewIfNeeded();
    const markerTop = (await marker.boundingBox()).y;
    await page.evaluate(() => window.__pideckReplyAudit.releaseImage());
    await reply.getByText('· Current file', { exact: true }).waitFor();
    await page.waitForTimeout(150);
    if (Math.abs((await marker.boundingBox()).y - markerTop) > 2) throw new Error('An asynchronous image moved the reading position.');
    await page.evaluate(text => window.__pideckReplyAudit.text(text), `${paragraph}\n\n`.repeat(30) + '![Bottom](bottom.png)');
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => window.__pideckReplyAudit.calls.some(call => call.href === 'bottom.png'));
    await page.evaluate(() => window.__pideckReplyAudit.releaseImage());
    await reply.getByRole('button', { name: 'Preview Bottom', exact: true }).waitFor();
    await page.waitForFunction(() => { const element = document.querySelector('.chat-scroll'); return element.scrollHeight - element.scrollTop - element.clientHeight < 2; });

    await page.evaluate(() => window.__pideckReplyAudit.text('![Retry image](retry.png)'));
    await reply.getByRole('alert').getByText('Image temporarily unavailable.', { exact: true }).waitFor();
    await reply.getByRole('button', { name: 'Retry image', exact: true }).click();
    await reply.getByRole('button', { name: 'Preview Retry image', exact: true }).waitFor();
    await page.evaluate(() => window.__pideckReplyAudit.text('![Slow](slow.png)'));
    await page.waitForFunction(() => window.__pideckReplyAudit.calls.some(call => call.href === 'slow.png'));
    await page.evaluate(() => { window.__pideckReplyAudit.text('![Remote](https://untrusted.invalid/screen.png)\n\n<script>window.pwned = true</script>'); window.__pideckReplyAudit.releaseImage(); });
    await reply.getByText(/Remote and embedded images are not loaded automatically/).waitFor();
    if (await reply.locator('img').count() || remote.length || await page.evaluate(() => window.pwned)) throw new Error('A stale or unsafe image entered the reply.');
    if (!await page.evaluate(() => window.__pideckReplyAudit.cancelled.some(call => call.href === 'slow.png'))) throw new Error('Abandoned image reads were not cancelled.');
    for (const code of ['flowchart LR\nA@{ img: "https://untrusted.invalid/mermaid.png" }', 'flowchart LR\nA-->B;classDef red fill:url(//untrusted.invalid/css)']) {
      await page.evaluate(code => window.__pideckReplyAudit.text('```mermaid\n' + code + '\n```'), code);
      await reply.getByRole('alert').getByText(/External assets/).waitFor();
    }
    if (remote.length) throw new Error('Mermaid measurement fetched an external asset.');
    await page.evaluate(() => window.__pideckReplyAudit.text('```mermaid\nnot a diagram\n```'));
    await reply.locator('.markdown-diagram').getByRole('alert').waitFor();
    await reply.getByRole('button', { name: 'Show source', exact: true }).click();
    if (await reply.locator('pre').textContent() !== 'not a diagram\n') throw new Error('Invalid Mermaid lost its source fallback.');

    const streaming = '## Streaming\n\n**Still generating**\n\n```typescript filename="src/live.ts"\nconst value = 1;\n```\n\n```mermaid\nflowchart LR\nA-->B';
    await page.evaluate(() => window.__pideckReplyAudit.text('## Streaming\n\n**Still generating', true));
    const live = page.locator('[data-message-id="live-assistant"]');
    await live.locator('strong').getByText('Still generating', { exact: true }).waitFor();
    await page.evaluate(text => window.__pideckReplyAudit.text(text, true), streaming);
    const liveCode = live.locator('.markdown-code-block').filter({ hasText: 'src/live.ts' });
    await liveCode.getByRole('button', { name: 'Wrap code', exact: true }).click();
    if (await live.locator('.markdown-diagram').count()) throw new Error('An incomplete Mermaid fence rendered prematurely.');
    await page.evaluate(text => window.__pideckReplyAudit.text(text + '\nB-->C', true), streaming);
    if (await liveCode.getByRole('button', { name: 'Wrap code', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('Streaming remounted code controls.');
    await page.screenshot({ path: 'output/playwright/pideck-replies-stream.png' });
    await page.evaluate(text => window.__pideckReplyAudit.text(text + '\n```\n', true), streaming);
    await live.getByRole('button', { name: 'Expand Mermaid diagram', exact: true }).waitFor();
    if (errors.length) throw new Error(errors.join('\n'));
    return 'Reply rendering flow passed: saved images, zoom/pan/focus, retries and cancellation, no remote requests, scoped anchors/footnotes, table export/fullscreen, code controls, proposed split diffs, Mermaid/source/error/theme and stable streaming.';
  } finally {
    await page.evaluate(previous => { localStorage.clear(); for (const [key, value] of Object.entries(previous)) localStorage.setItem(key, value); }, previous);
    await page.reload(); page.off('pageerror', onError); page.off('request', onRequest);
  }
}
