async page => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8_000);
  const workspace = page.getByRole("region", { name: "Workspace" });
  const nav = page.getByRole("complementary", { name: "Workspace navigation" });
  const prompt = page.getByRole("textbox", { name: "Message Pideck" });
  const queueEdit = page.getByRole("textbox", { name: "Edit queued message" });
  async function removeFromMenu(row, kind) {
    await page.waitForFunction(() => document.querySelector('.nav-scroll')?.getAttribute('aria-busy') !== 'true');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: `Remove ${kind}…`, exact: true }).click();
    await menu.waitFor({ state: 'detached' });
  }
  async function waitForQueueEditor() {
    await queueEdit.waitFor();
    await page.waitForFunction(() => {
      const editor = document.querySelector("#prompt");
      return editor?.getAttribute("aria-label") === "Edit queued message" && !editor.readOnly;
    });
  }
  const canvas = "rgb(10, 10, 10)";
  const panel = "rgb(34, 34, 34)";
  const control = "rgb(42, 42, 42)";
  const inputSurface = "rgb(27, 27, 27)";
  const overlay = "rgb(38, 38, 38)";
  const foreground = "rgb(243, 243, 243)";
  const green = "rgb(35, 134, 54)";
  async function expectColors(target, expected, pseudo) {
    const readColors = () => target.evaluate((element, { expected, pseudo }) => {
      if (!element.isConnected) return null;
      const style = getComputedStyle(element, pseudo);
      return Object.entries(expected).flatMap(([property, color]) => {
        const actual = style.getPropertyValue(property).trim();
        return actual === color ? [] : [`${property} expected ${color}, received ${actual}`];
      });
    }, { expected, pseudo });
    // Pierre can replace its diff spans when the highlighted view arrives.
    const differences = await readColors() ?? await readColors();
    if (!differences) throw new Error(`${target} detached while reading its colors.`);
    if (differences.length) throw new Error(`${target}: ${differences.join(", ")}`);
  }
  async function expectPaint(target, expected) {
    await target.evaluate((element, expected) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const color = getComputedStyle(element).backgroundColor;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const actual = [...context.getImageData(0, 0, 1, 1).data];
      const wanted = [...expected.matchAll(/[a-f\d]{2}/gi)].map(([pair]) => parseInt(pair, 16)).concat(255);
      if (actual.some((channel, index) => Math.abs(channel - wanted[index]) > 1)) {
        throw new Error(`Diff paint expected ${expected}, received ${color} (${actual.join(",")}).`);
      }
    }, expected);
  }
  const appearance = async (preference, resolved = preference) => {
    await page.evaluate(preference => window.dispatchEvent(new CustomEvent("pideck-fixture-appearance", { detail: preference })), preference);
    await page.waitForFunction(resolved => document.documentElement.dataset.colorMode === resolved, resolved);
  };
  async function footerGeometry(message) {
    return message.evaluate(article => {
      const footer = article.querySelector('.message-footer');
      const time = footer.querySelector('time');
      const bounds = footer.getBoundingClientRect();
      const timestamp = time.getBoundingClientRect();
      const buttons = [...footer.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      if (Math.abs(timestamp.left - bounds.left) > 1 || Math.abs(bounds.left - article.getBoundingClientRect().left) > 1
        || buttons.some(button => button.left < timestamp.right || button.right > bounds.right + 1)
        || bounds.top < article.querySelector('.message-content').getBoundingClientRect().bottom - 1) {
        throw new Error('AI metadata must start with its timestamp at the left edge, below the output and without overflow.');
      }
      return { font: getComputedStyle(time).fontSize, timeWidth: timestamp.width,
        buttons: buttons.map(button => ({ width: button.width, height: button.height })) };
    });
  }
  async function expectVisibleMetadata(message) {
    await prompt.focus();
    await page.mouse.move(0, 0);
    const metadata = message.locator(".message-footer, .message-footer time, .message-footer button");
    if (!await metadata.evaluateAll(items => items.length > 2 && items.every(item => getComputedStyle(item).opacity === "1"))) {
      throw new Error("Message timestamps and actions must remain visible without hover or keyboard focus.");
    }
    await message.hover();
    if (!await metadata.evaluateAll(items => items.every(item => getComputedStyle(item).opacity === "1"))) {
      throw new Error("Hover must not hide the timestamp or message actions.");
    }
    await prompt.focus();
    await page.mouse.move(0, 0);
    await message.locator(".message-footer button").first().focus();
    if (!await metadata.evaluateAll(items => items.every(item => getComputedStyle(item).opacity === "1"))) {
      throw new Error("Keyboard focus must keep the timestamp, Copy and Fork visible.");
    }
    await prompt.focus();
    await page.mouse.move(0, 0);
  }
  async function runClock() {
    return page.locator(".run-clock").evaluate(clock => {
      const startedAt = Number(clock.dataset.startedAt);
      const endedAt = clock.dataset.endedAt === undefined ? undefined : Number(clock.dataset.endedAt);
      const parts = clock.textContent.trim().split(":").map(Number);
      const seconds = parts.reduce((total, part) => total * 60 + part, 0);
      const elapsed = Math.floor(Math.max(0, (endedAt ?? Date.now()) - startedAt) / 1000);
      if (!Number.isFinite(startedAt) || !Number.isFinite(seconds) || parts.length < 2
        || endedAt !== undefined && (!Number.isFinite(endedAt) || endedAt < startedAt)
        || (endedAt === undefined ? Math.abs(elapsed - seconds) > 1 : elapsed !== seconds) || getComputedStyle(clock).opacity !== "1"
        || clock.getAttribute("role") !== "timer" || clock.getAttribute("aria-live") !== "off") {
        throw new Error("The visible elapsed clock must reflect the native run start, without per-second announcements.");
      }
      return { startedAt, endedAt, seconds };
    });
  }
  async function checkAssistantFooter(kind) {
    const message = page.locator('.chat-entry--assistant[data-message-id="reply"]');
    const viewport = page.viewportSize();
    for (const width of [1280, 720]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 900 });
      await appearance(theme);
      await message.hover();
      if (kind === 'finished') {
        const measured = await footerGeometry(message);
        if (measured.font !== '11px' || measured.buttons.length !== 2
          || measured.buttons.some(button => button.width !== 24 || button.height !== 24)) {
          throw new Error('The final AI timestamp and actions must use the common footer sizes.');
        }
        if (await page.locator('.chat-entry--assistant > .message-footer').count() !== 1) {
          throw new Error('Only the final answer should have AI message controls.');
        }
        await expectVisibleMetadata(message);
      } else if (await page.locator('.chat-entry--assistant > .message-footer').count()) {
        throw new Error('Intermediate AI text and tool messages must not show timestamps, copy or branch actions.');
      }
      if (width === 1280) await message.screenshot({ path: `output/playwright/pideck-footer-${kind}-${theme}.png` });
    }
    await appearance('dark');
    await page.setViewportSize(viewport);
  }

  async function checkNativeRunControls() {
    const viewport = page.viewportSize();
    const ordinaryDraft = await prompt.inputValue();
    const run = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent("pideck-fixture-run-controls", { detail })), detail);
    const originalPositions = new Map();
    const clockPositions = new Map();
    async function capture(stage, action) {
      if (stage !== "running") await page.locator(".run-clock[data-ended-at]").waitFor();
      const frozen = stage === "running" ? undefined : await runClock();
      for (const width of [1280, 720]) for (const theme of ["dark", "light"]) {
        await page.setViewportSize({ width, height: 900 });
        await appearance(theme);
        {
          const button = page.getByRole("button", { name: action ?? "Cancel run", exact: true });
          await button.waitFor();
          // Responsive panel and textarea sizing settle after ResizeObserver.
          // Hover waits for a stable target rather than sampling its old frame.
          await button.hover();
          await button.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const position = await button.evaluate(button => {
            const row = button.closest(".composer-run");
            const wrap = row.closest(".composer-wrap");
            const form = wrap.querySelector("form.composer").getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            const queue = wrap.querySelector(".queued-messages")?.getBoundingClientRect();
            const control = button.getBoundingClientRect();
            if (bounds.bottom > form.top + 1 || form.top - bounds.bottom > 10
              || queue && bounds.top < queue.bottom - 1
              || control.right > form.right + 1 || control.left < form.left) {
              throw new Error("Run controls must sit directly above the input, below the queue, without overflow.");
            }
            return { x: control.x, y: control.y, width: control.width, height: control.height };
          });
          const key = `${width}/${theme}`;
          if (stage === "running") originalPositions.set(key, position);
          else {
            const before = originalPositions.get(key);
            if (Object.keys(before).some(key => Math.abs(before[key] - position[key]) > 1)) {
              throw new Error(`Cancel and Continue moved when the queued messages were withdrawn at ${key}: ${JSON.stringify({ before, after: position })}`);
            }
          }
          if (await page.locator(".composer-run-control").count() !== 1 || await page.locator(".chat-run-error").count()) {
            throw new Error("The same run has duplicated controls or a second transcript status banner.");
          }
          if (stage === "completed") {
            if (!await button.isDisabled() || await page.getByRole("button", { name: "Continue run", exact: true }).count()
              || await page.locator('.composer-run[data-run-state="completed"]').count() !== 1
              || !await button.evaluate(button => {
                const style = getComputedStyle(button);
                const clock = button.closest(".composer-run").querySelector(".run-clock");
                return button.dataset.action === "cancel" && Boolean(button.querySelector("svg rect"))
                  && Number(style.opacity) > 0 && Number(style.opacity) <= .5
                  && style.color === getComputedStyle(clock).color;
              })) throw new Error("Completed work must retain one muted, disabled Cancel button beside its frozen clock.");
          } else if (!await button.isEnabled()) throw new Error("Running Cancel and eligible Continue controls must be enabled.");
        }
        await page.locator(".run-clock").hover();
        await page.locator(".run-clock").evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const clock = await runClock();
        if (stage === "running" ? clock.endedAt !== undefined : clock.endedAt === undefined) {
          throw new Error("Run clocks must tick while active and carry the native end timestamp when settled.");
        }
        const clockPosition = await page.locator(".run-clock").boundingBox();
        const clockKey = `${width}/${theme}`;
        if (stage === "running") clockPositions.set(clockKey, clockPosition);
        else {
          const original = clockPositions.get(clockKey);
          if (["x", "y", "width", "height"].some(key => Math.abs(original[key] - clockPosition[key]) > 1)) {
            throw new Error(`The settled clock moved from its running position at ${clockKey}.`);
          }
        }
        if (stage === "running") await page.locator('[data-message-id="controls-tools"]').hover();
        if (width === 1280) await page.screenshot({ path: `output/playwright/pideck-run-controls-${stage}-${theme}.png` });
      }
      await appearance("dark");
      await page.setViewportSize(viewport);
      if (frozen) {
        await page.waitForTimeout(1_100);
        if (JSON.stringify(await runClock()) !== JSON.stringify(frozen)) throw new Error("A settled run clock kept counting.");
      }
    }
    await run("start");
    const controlTool = page.locator('[data-message-id="controls-tools"]');
    const cancelTool = controlTool.getByRole("button", { name: "Cancel this tool", exact: true });
    await cancelTool.waitFor();
    await prompt.fill("This queued message should be withdrawn by Cancel.");
    await page.getByRole("button", { name: "Queue next", exact: true }).click();
    const controlsQueue = page.getByRole("list", { name: "Queued messages", exact: true });
    await controlsQueue.getByText("This queued message should be withdrawn by Cancel.", { exact: true }).waitFor();
    const draft = "Keep this ordinary draft while cancelling and continuing.";
    await prompt.fill(draft);
    const userMessages = await page.getByRole("article", { name: "You", exact: true }).allTextContents();
    await capture("running", "Cancel run");
    await prompt.focus();
    await page.mouse.move(0, 0);
    const initialClock = await runClock();
    await page.waitForFunction(previous => {
      const clock = document.querySelector(".run-clock");
      return clock && clock.textContent.trim().split(":").map(Number).reduce((total, part) => total * 60 + part, 0) > previous;
    }, initialClock.seconds);
    if ((await runClock()).startedAt !== initialClock.startedAt) throw new Error("The active stopwatch restarted on its own.");
    await controlsQueue.getByRole("button", { name: "Steer current run", exact: true }).click();
    await controlsQueue.getByText("Steering", { exact: true }).waitFor();
    if ((await runClock()).startedAt !== initialClock.startedAt) throw new Error("Steering reset the active run stopwatch.");
    await cancelTool.click();
    await page.waitForFunction(() => document.body.dataset.cancelledTask === "9001");
    await page.getByText("Continuing after the tool cancellation.", { exact: true }).waitFor();
    if (await page.getByRole("button", { name: "Cancel run", exact: true }).count() !== 1
      || await controlsQueue.count() !== 1 || await prompt.inputValue() !== draft
      || await controlTool.locator(".message-footer").count()
      || await controlTool.locator('.tool-state[aria-label="Cancelled"]').count() !== 1) {
      throw new Error("Cancelling one tool changed the run, queue, draft, or intermediate footer scope.");
    }
    if ((await runClock()).startedAt !== initialClock.startedAt) throw new Error("A tool result reset the active run stopwatch.");
    await run("next-tool");
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByRole("button", { name: "Continue run", exact: true }).waitFor();
    await controlsQueue.waitFor({ state: "detached" });
    if (await page.evaluate(() => document.body.dataset.withdrawnInputs) !== "1" || await prompt.inputValue() !== draft) {
      throw new Error("Cancelling a run did not withdraw its queue while retaining the draft.");
    }
    await capture("cancelled", "Continue run");
    await page.getByRole("button", { name: "Continue run", exact: true }).click();
    await page.getByText("Continuing the unfinished work…", { exact: true }).waitFor();
    await page.locator(".run-clock").waitFor();
    if ((await runClock()).startedAt <= initialClock.startedAt) throw new Error("Continue did not start a new run stopwatch.");
    if (await page.evaluate(() => document.body.dataset.continueRequests) !== "1"
      || JSON.stringify(await page.getByRole("article", { name: "You", exact: true }).allTextContents()) !== JSON.stringify(userMessages)
      || await prompt.inputValue() !== draft) throw new Error("Continue inserted a user message or sent the ordinary draft.");
    await run("fail");
    await page.locator('.composer-run[data-run-state="failed"] .run-state[role="alert"]')
      .getByText("The provider connection failed.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Continue run", exact: true }).waitFor();
    if (await page.getByText("The provider connection failed.", { exact: true }).count() !== 1) {
      throw new Error("A failed run repeats the same error in multiple places.");
    }
    await capture("failed", "Continue run");
    await page.getByRole("button", { name: "Continue run", exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.continueRequests === "2");
    await run("finish");
    const final = page.locator('[data-message-id="controls-final"]');
    await final.locator(".message-footer").waitFor();
    await page.locator('.composer-run[data-run-state="completed"]').waitFor();
    if (await page.locator(".message-duration").count()
      || await page.getByRole("button", { name: "Continue run", exact: true }).count()
      || await prompt.inputValue() !== draft
      || JSON.stringify(await page.getByRole("article", { name: "You", exact: true }).allTextContents()) !== JSON.stringify(userMessages)) {
      throw new Error("Continue completion lost its final footer or changed user-authored content.");
    }
    await final.hover();
    await capture("completed");
    await run("restore");
    await prompt.fill(ordinaryDraft);
    await appearance("dark");
    await page.setViewportSize(viewport);
  }

  const open = page.getByRole("button", { name: /^Open (?:a project )?folder$/i });
  await open.waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await appearance("system", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.colorMode === "light");
  await appearance("dark");
  if (await open.count() !== 1 || await nav.count()) throw new Error("Welcome has duplicate workspace navigation.");
  await expectColors(page.locator("html"), {
    "--bgColor-default": "#0a0a0a",
    "--button-primary-bgColor-rest": "#238636",
    "background-color": canvas,
    "color": foreground,
  });
  await expectColors(open, { "background-color": green, "color": "rgb(255, 255, 255)" });
  await page.screenshot({ path: "output/playwright/pideck-ui-welcome.png" });
  await open.click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  if (await page.locator(".workspace-title-current").textContent() !== "Sample project") {
    throw new Error("The project name is missing before starting a session.");
  }
  if (await workspace.getByRole("button", { name: /Trust project/i }).count()) {
    throw new Error("Opening a folder still requires a second permission step.");
  }
  const projectRow = nav.getByRole("button", { name: "Sample project", exact: true });
  const newSession = nav.getByRole("button", { name: "New session in Sample project", exact: true });
  const leftDivider = page.getByRole("separator", { name: "Resize left sidebar", exact: true });
  const originalNavigationWidth = (await nav.boundingBox()).width;
  const leftHandle = await leftDivider.boundingBox();
  await page.mouse.move(leftHandle.x + leftHandle.width / 2, leftHandle.y + leftHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftHandle.x + leftHandle.width / 2 + 48, leftHandle.y + leftHandle.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(width => document.getElementById("workspace-navigation").getBoundingClientRect().width > width + 30, originalNavigationWidth);
  const draggedNavigationWidth = (await nav.boundingBox()).width;
  await leftDivider.press("ArrowLeft");
  await page.waitForFunction(width => Math.abs(document.getElementById("workspace-navigation").getBoundingClientRect().width - width) <= 1,
    draggedNavigationWidth - 16);
  const preferredNavigationWidth = (await nav.boundingBox()).width;
  if (!await nav.evaluate(navigation => {
    const edge = navigation.getBoundingClientRect().right;
    return Math.abs(document.querySelector(".titlebar-leading").getBoundingClientRect().right - edge) <= 1
      && Math.abs(document.querySelector(".workspace").getBoundingClientRect().left - edge) <= 1;
  })) throw new Error("Resizing the left sidebar misaligned its header or workspace.");
  await projectRow.hover();
  await newSession.click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  const sessionCount = () => page.evaluate(async () => {
    const [project] = await window.pideck.invoke("project:list");
    return (await window.pideck.invoke("session:list", { projectId: project.id })).length;
  });
  if (await sessionCount() !== 0) throw new Error("Opening the project created a blank session.");
  await page.screenshot({ path: "output/playwright/pideck-ui-first-draft.png" });
  const connect = page.getByRole("button", { name: "Connect a provider", exact: true });
  if (await connect.count() !== 1) throw new Error("The composer has duplicate provider setup actions.");
  await connect.click();
  const settings = page.getByRole("dialog", { name: "Model providers" });
  const provider = settings.getByRole("combobox", { name: "Provider", exact: true });
  const signIn = settings.getByRole("region", { name: "Provider sign-in", exact: true });
  const browserPrompt = "Complete login in your browser, or paste the final redirect URL here:";
  async function expectBrowserInstructions() {
    await settings.getByLabel(browserPrompt, { exact: true }).waitFor();
    if (await signIn.getByText("Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.", { exact: true }).count()
      || await signIn.getByText(browserPrompt, { exact: true }).count() !== 1) {
      throw new Error("OpenAI browser sign-in repeats instructions above its manual redirect input.");
    }
    await signIn.getByRole("button", { name: "Open auth.fixture.invalid", exact: true }).waitFor();
  }
  async function expectSignInActions() {
    const cancel = signIn.getByRole("button", { name: "Cancel", exact: true });
    const proceed = signIn.getByRole("button", { name: "Continue", exact: true });
    await proceed.waitFor();
    if (await cancel.count() !== 1 || await settings.getByRole("button", { name: "Cancel", exact: true }).count() !== 1) {
      throw new Error("Sign-in must offer one Cancel action within the input card.");
    }
    const [card, back, next] = await Promise.all([signIn.boundingBox(), cancel.boundingBox(), proceed.boundingBox()]);
    if (!card || !back || !next || back.x + back.width > next.x || next.x - back.x - back.width > 16
      || Math.abs(back.y + back.height / 2 - next.y - next.height / 2) > 1
      || back.x < card.x || next.x + next.width > card.x + card.width
      || back.y < card.y || next.y + next.height > card.y + card.height) {
      throw new Error("Sign-in Cancel must sit immediately left of Continue on the same line inside the card.");
    }
  }
  await provider.locator('option[value="openai"]').waitFor({ state: "attached" });
  await expectColors(settings, { "background-color": overlay, "border-top-color": "rgb(58, 58, 58)", "color": foreground });
  await expectColors(settings, { "background-color": "rgba(0, 0, 0, 0.55)" }, "::backdrop");
  await expectColors(provider, { "background-color": canvas, "border-top-color": "rgb(58, 58, 58)", "color": foreground });
  await appearance("light");
  await expectColors(settings, { "background-color": "rgb(255, 255, 255)", "color": "rgb(23, 23, 23)" });
  await expectColors(provider, { "background-color": "rgb(253, 253, 253)", "color": "rgb(23, 23, 23)" });
  await page.screenshot({ path: "output/playwright/pideck-ui-light-providers.png" });
  await appearance("dark");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  if (!await connect.evaluate(button => button === document.activeElement)) throw new Error("Closing the provider dialog did not restore focus.");
  await connect.press("Enter");
  await provider.locator('option[value="openai"]').waitFor({ state: "attached" });
  if (await provider.inputValue() !== "") throw new Error("Provider setup chose an account without user input.");
  await provider.click();
  await expectColors(provider, { "background-color": overlay }, "::picker(select)");
  await provider.getByRole("option", { name: "Fixture provider", exact: true }).click();
  if (await settings.getByRole("combobox", { name: "Sign-in method" }).count()) throw new Error("Connection methods repeat an extra selection step.");
  await settings.getByRole("button", { name: "API key", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-providers.png" });
  await settings.getByRole("button", { name: "ChatGPT subscription", exact: true }).click();
  await settings.getByText("PIDE-CK99").waitFor();
  await settings.getByRole("button", { name: /Open fixture.invalid/ }).click();
  await settings.getByRole("button", { name: "Copy code" }).click();
  const authorization = settings.getByLabel(browserPrompt, { exact: true });
  const continueSignIn = settings.getByRole("button", { name: "Continue" });
  await expectBrowserInstructions();
  await signIn.getByRole("button", { name: "Open auth.fixture.invalid", exact: true }).click();
  await expectSignInActions();
  await expectColors(authorization, { "background-color": canvas });
  await expectColors(continueSignIn, { "background-color": "rgb(16, 88, 35)" });
  await page.screenshot({ path: "output/playwright/pideck-ui-provider-sign-in.png" });
  await authorization.fill("test-authorization");
  await expectColors(continueSignIn, { "background-color": green });
  await continueSignIn.click();
  await settings.getByText("Fixture provider connected.").waitFor();
  const connection = settings.getByRole("region", { name: "Provider connection" });
  await expectColors(connection, { "background-color": canvas });
  await expectColors(connection.locator(".key-status > span"), { "background-color": "rgb(63, 185, 80)" });
  async function expectAlignedConnection(actionCount) {
    const aligned = await connection.evaluate((card, actionCount) => {
      const bounds = card.getBoundingClientRect();
      const status = card.querySelector(".key-status").getBoundingClientRect();
      const actions = [...card.querySelectorAll(".provider-connection-header button")];
      return actions.length === actionCount && actions.every(action => {
        const button = action.getBoundingClientRect();
        return Math.abs(button.top + button.height / 2 - status.top - status.height / 2) < 1
          && button.left >= bounds.left && button.right <= bounds.right
          && action.scrollWidth <= action.clientWidth + 1;
      });
    }, actionCount);
    if (!aligned) throw new Error("The connected status and complete action labels do not align within the card.");
  }
  await expectAlignedConnection(3);
  await connection.getByRole("button", { name: "Refresh models", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-providers-connected.png" });
  const currentConnection = () => page.evaluate(async () => (await window.pideck.invoke("model:providers"))
    .find(item => item.id === "openai"));
  const originalViewport = page.viewportSize();
  for (const theme of ["light", "dark"]) {
    await appearance(theme);
    await expectAlignedConnection(3);
    await page.setViewportSize({ width: 420, height: 760 });
    await expectAlignedConnection(3);
    await page.setViewportSize(originalViewport);
    await connection.getByRole("button", { name: "Remove", exact: true }).click();
    await connection.getByText("Remove the saved connection to Fixture provider?", { exact: true }).waitFor();
    if (await page.locator("dialog[open]").count() !== 1) throw new Error("Removing a connection opened a second dialog.");
    await connection.getByRole("button", { name: "Cancel", exact: true }).click();
    if (!(await currentConnection()).configured) throw new Error("Cancelling removal disconnected the saved provider.");
    await connection.getByRole("button", { name: "Change", exact: true }).click();
    const apiKeyOption = connection.getByRole("button", { name: "API key", exact: true });
    const subscriptionOption = connection.getByRole("button", { name: "ChatGPT subscription", exact: true });
    await apiKeyOption.waitFor();
    if (/Choose how|Fixture provider API key|Fixture provider \(ChatGPT/.test(await connection.textContent())) {
      throw new Error("Connection method choices repeat provider names or explanatory text.");
    }
    await page.mouse.move(0, 0);
    const neutral = theme === "light" ? "rgb(244, 244, 244)" : control;
    for (const option of [apiKeyOption, subscriptionOption]) await expectColors(option, { "background-color": neutral });
    const optionStyle = async option => option.evaluate(button => {
      const style = getComputedStyle(button);
      return [style.height, style.borderTopColor, style.borderTopWidth, style.borderRadius, style.color, style.fontSize];
    });
    if (JSON.stringify(await optionStyle(apiKeyOption)) !== JSON.stringify(await optionStyle(subscriptionOption))) {
      throw new Error("Connection method options have inconsistent button styles.");
    }
    const back = connection.getByRole("button", { name: "Back", exact: true });
    if (await back.evaluate(button => getComputedStyle(button).backgroundColor) === neutral) {
      throw new Error("Back is styled as a connection method instead of a secondary action.");
    }
    await page.screenshot({ path: `output/playwright/pideck-ui-${theme === "light" ? "light-" : ""}providers-change.png` });
    await apiKeyOption.click();
    await settings.getByLabel("API key", { exact: true }).waitFor();
    await expectSignInActions();
    await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
    if ((await currentConnection()).credential !== "oauth") throw new Error("Cancelling key replacement changed the saved subscription connection.");
    await subscriptionOption.click();
    await expectBrowserInstructions();
    await expectSignInActions();
    await page.screenshot({ path: `output/playwright/pideck-ui-${theme === "light" ? "light-" : ""}provider-sign-in.png` });
    await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
    if ((await currentConnection()).credential !== "oauth") throw new Error("Cancelling subscription replacement changed the saved connection.");
    await back.click();
    await connection.getByRole("button", { name: "Change", exact: true }).waitFor();
  }

  // A provider with one method stays neutral on first setup and skips that
  // method-selection step entirely when changing an already-saved connection.
  await provider.selectOption("other");
  const singleKeyOption = connection.getByRole("button", { name: "API key", exact: true });
  for (const theme of ["light", "dark"]) {
    await appearance(theme);
    await page.mouse.move(0, 0);
    await expectColors(singleKeyOption, { "background-color": theme === "light" ? "rgb(244, 244, 244)" : control });
  }
  await singleKeyOption.click();
  const keyPrompt = settings.getByLabel("API key", { exact: true });
  await keyPrompt.fill("test-api-key");
  await settings.getByRole("button", { name: "Continue", exact: true }).click();
  await settings.getByText("Another provider connected.", { exact: true }).waitFor();
  for (const theme of ["light", "dark"]) {
    await appearance(theme);
    await expectAlignedConnection(2);
    await connection.getByRole("button", { name: "Change", exact: true }).click();
    await keyPrompt.waitFor();
    await expectSignInActions();
    if (await connection.count()) throw new Error("Changing a single-method connection still shows an intermediate choice card.");
    await page.screenshot({ path: `output/playwright/pideck-ui-${theme === "light" ? "light-" : ""}providers-key.png` });
    await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
    await connection.getByRole("button", { name: "Change", exact: true }).waitFor();
    await expectAlignedConnection(2);
  }
  await connection.getByRole("button", { name: "Change", exact: true }).click();
  await keyPrompt.fill("test-api-key");
  await settings.getByRole("button", { name: "Continue", exact: true }).click();
  await settings.getByText("Another provider connected.", { exact: true }).waitFor();
  await connection.getByRole("button", { name: "Remove", exact: true }).click();
  await connection.getByText("Remove the saved connection to Another provider?", { exact: true }).waitFor();
  await connection.getByRole("button", { name: "Remove", exact: true }).click();
  await singleKeyOption.waitFor();
  const removed = await page.evaluate(async () => (await window.pideck.invoke("model:providers")).find(item => item.id === "other"));
  if (removed.configured || removed.credential) throw new Error("Removing the saved single-method connection left credential state behind.");
  if (!(await currentConnection()).configured) throw new Error("Removing another connection affected the primary provider.");
  await provider.selectOption("openai");
  await connection.getByRole("button", { name: "Change", exact: true }).waitFor();
  await appearance("dark");
  await settings.getByRole("button", { name: "Close settings" }).click();

  await prompt.fill("Update and verify the status.");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Update and verify the status.");
  if (Math.abs((await nav.boundingBox()).width - preferredNavigationWidth) > 1) throw new Error("Reloading lost the left sidebar width.");
  await leftDivider.press("Enter");
  await page.waitForFunction(width => Math.abs(document.getElementById("workspace-navigation").getBoundingClientRect().width - width) <= 1,
    originalNavigationWidth);
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("pideck.workspace.v1")).navigationWidth) !== undefined) {
    throw new Error("Resetting the left sidebar kept its saved manual width.");
  }
  if (await sessionCount() !== 0) throw new Error("Writing an unsent draft created a session.");

  const model = page.getByRole("button", { name: "Model", exact: true });
  const composer = page.locator(".composer");
  const picker = page.getByRole("region", { name: "Choose a model" });
  const modelSearch = picker.getByRole("searchbox", { name: "Search models" });
  const thinkingLevel = picker.getByRole("combobox", { name: "Thinking level" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await page.waitForFunction(() => document.body.dataset.savedModelCatalog === "pending");
  await model.getByText("Choose a model", { exact: true }).waitFor();
  if (await connect.count()) throw new Error("A pending saved connection prompted the user to connect again.");
  await send.click();
  await page.getByRole("alert").getByText("The fixture unlock was cancelled.").waitFor();
  if (await prompt.inputValue() !== "Update and verify the status." || await sessionCount() !== 0) {
    throw new Error("Cancelling a saved connection lost the unsent draft or started a session.");
  }
  await expectColors(composer, { "background-color": inputSurface });
  await expectColors(prompt, { "color": foreground });
  await model.press("ArrowDown");
  await page.waitForFunction(() => document.body.dataset.savedModelCatalog === "available");
  await model.getByText("Off", { exact: true }).waitFor();
  await expectColors(picker, { "background-color": overlay, "color": foreground });
  await expectColors(modelSearch, { "background-color": canvas });
  const modelGroup = picker.getByRole("group", { name: "OpenAI models", exact: true });
  if (await modelGroup.count() !== 1 || await modelGroup.getByText("OpenAI", { exact: true }).count() !== 1) {
    throw new Error("Models do not share one provider heading.");
  }
  const configuredModelOption = modelGroup.getByRole("button", { name: "Fixture model · OpenAI · 128,000 token context · Supports images", exact: true });
  await configuredModelOption.getByText("128k", { exact: true }).waitFor();
  if (!await configuredModelOption.locator('[title="Supports images"] svg').count()) throw new Error("The image-capability glyph is missing.");
  await appearance("light");
  await expectColors(picker, { "background-color": "rgb(255, 255, 255)", "color": "rgb(23, 23, 23)" });
  await expectColors(modelSearch, { "background-color": "rgb(253, 253, 253)", "color": "rgb(23, 23, 23)" });
  await page.screenshot({ path: "output/playwright/pideck-ui-light-model-menu.png" });
  await appearance("dark");
  if (await picker.getByRole("button", { name: "Browse all models", exact: true }).count()) {
    throw new Error("The picker still offers unconfigured models.");
  }
  await modelSearch.fill("anthropic");
  await picker.getByText("No models match your search.", { exact: true }).waitFor();
  await modelSearch.fill("fixture fixed");
  await picker.getByRole("button", { name: /Fixture fixed model/ }).waitFor();
  await modelSearch.press("Enter");
  await model.getByText(/^Fixture fixed model/).waitFor();
  if (await model.getByText("Off", { exact: true }).count()
    || (await model.getAttribute("aria-description"))?.includes("Thinking")) {
    throw new Error("A model without thinking still displays an Off level.");
  }
  await picker.waitFor({ state: "hidden" });
  if (!await model.evaluate(button => button === document.activeElement)) {
    throw new Error("Choosing a fixed thinking level did not return focus to the model button.");
  }
  const fixedLevelFits = await model.evaluate(button => {
    const name = button.querySelector(".model-summary-name");
    const chevron = button.querySelector("svg");
    const bounds = button.getBoundingClientRect();
    return !button.querySelector(".model-summary-thinking") && name && chevron
      && name.getBoundingClientRect().right <= chevron.getBoundingClientRect().left
      && chevron.getBoundingClientRect().right < bounds.right;
  });
  if (!fixedLevelFits) throw new Error("The long model name clipped its menu chevron.");

  const pasteImage = (width = 640, height = 360) => prompt.evaluate(async (textarea, size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#0d1117";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#161b22";
    context.fillRect(28, 28, 584, 304);
    context.fillStyle = "#f0f6fc";
    context.font = "28px sans-serif";
    context.fillText("Pideck image preview", 52, 90);
    context.fillStyle = "#3fb950";
    context.font = "21px monospace";
    context.fillText("export const status = 'verified';", 52, 160);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([png], "pasted-preview.png", { type: "image/png" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  }, { width, height });
  const attachmentPreview = composer.getByRole("button", { name: "Preview attached image 1", exact: true });
  const removeAttachment = composer.getByRole("button", { name: "Remove attached image 1", exact: true });
  const imagePreview = page.getByRole("dialog", { name: "Image preview", exact: true });
  const expectPreviewImageSize = async (width, height) => {
    const fits = await imagePreview.getByRole("img").evaluate(async (image, natural) => {
      await image.decode();
      const dialog = image.closest("dialog");
      const style = getComputedStyle(dialog);
      const availableWidth = dialog.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availableHeight = dialog.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
      const bounds = image.getBoundingClientRect();
      return image.naturalWidth === natural.width && image.naturalHeight === natural.height
        && Math.abs(bounds.width - natural.width * scale) < 1
        && Math.abs(bounds.height - natural.height * scale) < 1;
    }, { width, height });
    if (!fits) throw new Error(`The ${width}×${height} image was enlarged or did not shrink proportionally to fit the window.`);
  };
  await pasteImage();
  await attachmentPreview.waitFor();
  await removeAttachment.waitFor();
  if ((await composer.locator(".attachments").textContent()).includes("pasted-preview.png")) {
    throw new Error("A pasted image still displays its filename in the composer.");
  }
  await composer.screenshot({ path: "output/playwright/pideck-ui-image-attachment.png" });
  await attachmentPreview.focus();
  await page.keyboard.press("Enter");
  await imagePreview.getByRole("img", { name: "Attached image 1", exact: true }).waitFor();
  await expectPreviewImageSize(640, 360);
  const windowPreview = await imagePreview.evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect();
    const close = dialog.querySelector("button").getBoundingClientRect();
    const imageElement = dialog.querySelector("img");
    const image = imageElement.getBoundingClientRect();
    return bounds.left === 0 && bounds.top === 0 && bounds.width === innerWidth && bounds.height === innerHeight
      && close.top >= 8 && close.top <= 24 && innerWidth - close.right >= 8 && innerWidth - close.right <= 24
      && image.left >= 0 && image.top >= 0 && image.right <= innerWidth && image.bottom <= innerHeight
      && getComputedStyle(imageElement).objectFit === "contain";
  });
  if (!windowPreview) throw new Error("The image preview does not fit the window with its close button in the upper-right corner.");
  await expectColors(imagePreview, { "background-color": "rgba(0, 0, 0, 0)", "border-top-width": "0px" });
  await expectColors(imagePreview, { "background-color": "rgba(0, 0, 0, 0)" }, "::backdrop");
  if (await sessionCount() !== 0 || await page.locator("#prompt").inputValue() !== "Update and verify the status.") {
    throw new Error("Previewing a pasted image submitted or changed the unsent message.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-image-preview.png" });
  await page.keyboard.press("Escape");
  await imagePreview.waitFor({ state: "hidden" });
  if (!await attachmentPreview.evaluate(button => button === document.activeElement)) throw new Error("Closing the image preview did not restore focus.");
  await attachmentPreview.click();
  await imagePreview.getByRole("button", { name: "Close image preview", exact: true }).click();
  await imagePreview.waitFor({ state: "hidden" });
  await attachmentPreview.click();
  await imagePreview.getByRole("img", { name: "Attached image 1", exact: true }).click();
  if (!await imagePreview.isVisible()) throw new Error("Clicking the preview image closed it.");
  await imagePreview.click({ position: { x: 2, y: 2 } });
  await imagePreview.waitFor({ state: "hidden" });
  await removeAttachment.click();
  await attachmentPreview.waitFor({ state: "detached" });
  if (await imagePreview.count()) throw new Error("Removing an image opened its preview.");
  for (const [width, height] of [[2400, 600], [600, 2400]]) {
    await pasteImage(width, height);
    await attachmentPreview.click();
    await expectPreviewImageSize(width, height);
    await page.keyboard.press("Escape");
    await imagePreview.waitFor({ state: "hidden" });
    await removeAttachment.click();
    await attachmentPreview.waitFor({ state: "detached" });
  }
  await pasteImage();
  await attachmentPreview.waitFor();
  await model.press("ArrowDown");
  await modelSearch.waitFor();
  if (await thinkingLevel.count()) throw new Error("A fixed thinking level exposes a redundant control.");
  await modelSearch.fill("fixture model");
  await picker.getByRole("button", { name: /^Fixture model/ }).waitFor();
  await modelSearch.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.classList.contains("model-option"));
  await page.keyboard.press("Enter");
  await modelSearch.waitFor();
  await thinkingLevel.selectOption("high");
  await model.getByText("High", { exact: true }).waitFor();
  await expectColors(picker.locator('.model-option[aria-current="true"]'), {
    "background-color": "rgba(255, 255, 255, 0.08)",
    "border-top-color": "rgba(0, 0, 0, 0)",
  });
  if (!(await model.getAttribute("aria-description"))?.endsWith(" · Thinking high")) {
    throw new Error("The model button does not describe what its level means.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-model-menu.png" });
  await thinkingLevel.press("Escape");
  await picker.waitFor({ state: "hidden" });
  if (!await model.evaluate(button => button === document.activeElement)) throw new Error("Dismissing the model menu did not restore focus.");
  await composer.screenshot({ path: "output/playwright/pideck-ui-model-thinking.png" });
  await prompt.hover();
  await expectColors(send, { "background-color": green });
  await send.click();
  await page.getByRole("status").getByText("Running command…", { exact: true }).waitFor();
  await page.locator(".composer-current-model").getByText("High", { exact: true }).waitFor();
  const runningSessionId = await nav.locator(".nav-session-row[aria-current=true]").getAttribute("id");
  const runningSession = nav.locator(`#${runningSessionId}`);
  await runningSession.locator("[data-activity=running] svg.lucide-loader-circle").waitFor();
  if (await prompt.inputValue() !== "") throw new Error("Accepted draft was not reconciled on reconnect.");
  if (await sessionCount() !== 1) throw new Error("The first send did not create exactly one session.");
  await page.getByText("Running the status check…", { exact: true }).waitFor();
  const sentImage = page.getByRole("article", { name: "You", exact: true }).getByRole("button", { name: "Preview attached image", exact: true });
  await sentImage.click();
  await imagePreview.getByRole("img", { name: "Attached image", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await imagePreview.waitFor({ state: "hidden" });

  await prompt.hover();
  await prompt.focus();
  if (await nav.getByRole("button", { name: "New session", exact: true }).count()
    || !await newSession.evaluate(button => button.parentElement.classList.contains("nav-project-row")
      && getComputedStyle(button).opacity === "1" && getComputedStyle(button).pointerEvents !== "none")) {
    throw new Error("The project's new-session button is not always visible and available.");
  }
  await newSession.click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  if (await sessionCount() !== 1 || await prompt.inputValue() !== "") throw new Error("New session did not open a blank draft.");
  await runningSession.click();
  if (await sessionCount() !== 1) throw new Error("Leaving a blank draft left an empty session.");
  await prompt.hover();
  await projectRow.press("Tab");
  if (!await newSession.evaluate(button => button === document.activeElement && getComputedStyle(button).opacity === "1")) {
    throw new Error("Tab did not focus the project's new-session button.");
  }
  await newSession.press("Enter");
  await prompt.fill("Start a separate session.");
  await runningSession.click();
  const resumeDraft = nav.getByRole("button", { name: "Resume unsent draft in Sample project", exact: true });
  await prompt.hover();
  if (!await resumeDraft.evaluate(button => button.textContent.trim() === "Draft" && getComputedStyle(button).opacity === "1")) {
    throw new Error("An unsent draft did not leave a visible cue on its project row.");
  }
  await resumeDraft.click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Start a separate session.");
  if (await sessionCount() !== 1) throw new Error("Switching away from a draft created a session.");
  await model.click();
  await modelSearch.fill("fixture fixed");
  await picker.getByRole("button", { name: /Fixture fixed model/ }).click();
  await picker.waitFor({ state: "hidden" });
  await prompt.press("Enter");
  await runningSession.click();
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-start")));
  const startedSession = nav.getByRole("button", { name: "Start a separate session.", exact: true });
  await startedSession.waitFor();
  if (await runningSession.getAttribute("aria-current") !== "true") throw new Error("A late first-send reply changed the active session.");
  await startedSession.click();
  await page.locator(".composer-current-model").getByText(/^Fixture fixed model/).waitFor();
  if (await page.locator(".composer-current-model .model-summary-thinking").count()) {
    throw new Error("A running model without thinking still displays a level.");
  }
  const secondaryQueue = page.getByRole("list", { name: "Queued messages" });
  const secondaryDraft = "Keep the ordinary draft while editing.";
  for (const action of ["save", "cancel"]) {
    if (action === "cancel") {
      await prompt.fill("Run the cancellation check.");
      await prompt.press("Enter");
    }
    const target = action === "save" ? "Wait for the edited message." : "Keep the original queued message.";
    const suffix = action === "save" ? "Follow-up after save." : "Follow-up after cancel.";
    for (const text of [target, suffix]) {
      await prompt.fill(text);
      await page.getByRole("button", { name: "Queue next", exact: true }).click();
      await secondaryQueue.getByText(text, { exact: true }).waitFor();
    }
    const targetRow = secondaryQueue.getByRole("listitem").filter({ hasText: target });
    const targetId = await targetRow.getAttribute("data-queue-id");
    await prompt.fill(secondaryDraft);
    if (action === "save") await page.evaluate(() => sessionStorage.setItem("pideck-fail-edit-start", "1"));
    await targetRow.hover();
    await targetRow.getByRole("button", { name: "Edit message", exact: true }).click();
    if (action === "save") {
      const lostAcknowledgement = "The fixture lost the queue edit acknowledgement.";
      await page.getByRole("alert").getByText(lostAcknowledgement, { exact: true }).waitFor();
      const pending = await page.waitForFunction(({ id, draft }) => {
        for (const [key, value] of Object.entries(localStorage)) {
          if (!key.startsWith("pideck.draft.v1/")) continue;
          const saved = JSON.parse(value);
          if (saved.queueEdit?.id === Number(id) && saved.queueEdit.loading && saved.text === draft) {
            return { key, token: saved.queueEdit.token };
          }
        }
      }, { id: targetId, draft: secondaryDraft }).then(handle => handle.jsonValue());
      const holdCommitted = await page.evaluate(({ id, token }) => Object.values(
        JSON.parse(localStorage.getItem("pideck-browser-fixture")).queueHolds,
      ).some(hold => hold.id === Number(id) && hold.token === token), { id: targetId, token: pending.token });
      if (!holdCommitted || !await queueEdit.evaluate(editor => editor.readOnly)) {
        throw new Error("A lost edit acknowledgement did not retain the pending token and committed hold.");
      }
      await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-second-run")));
      await page.getByText("Secondary work completed.", { exact: true }).first().waitFor();
      if (await secondaryQueue.getByRole("listitem").count() !== 2
        || await secondaryQueue.locator(`[data-queue-id="${targetId}"]`).count() !== 1
        || await page.getByRole("article", { name: "You", exact: true }).getByText(suffix, { exact: true }).count()) {
        throw new Error("Losing the edit acknowledgement released its target or let a follow-up pass it.");
      }
      await page.getByRole("button", { name: "Retry queue edit", exact: true }).click();
      await waitForQueueEditor();
      const resumed = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), pending.key);
      if (await queueEdit.inputValue() !== target || resumed.queueEdit?.token !== pending.token
        || resumed.queueEdit.loading || await page.getByText(lostAcknowledgement, { exact: true }).count()) {
        throw new Error("Retrying a lost edit acknowledgement did not reclaim its token and original text.");
      }
    }
    const editedText = action === "save" ? "Save the revised queued message." : "Discard the temporary queued edits.";
    await waitForQueueEditor();
    await queueEdit.fill(editedText);
    if (action === "cancel") await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-second-run")));
    await page.getByText("Secondary work completed.", { exact: true }).first().waitFor();
    if (await secondaryQueue.getByRole("listitem").count() !== 2 || await queueEdit.inputValue() !== editedText
      || await secondaryQueue.locator(`[data-queue-id="${targetId}"]`).count() !== 1
      || await page.getByRole("article", { name: "You", exact: true }).getByText(suffix, { exact: true }).count()) {
      throw new Error("Finishing the current work consumed an edited queue item or let its follow-up pass it.");
    }
    if (action === "save") {
      const persisted = await page.waitForFunction(({ id, text, draft }) => {
        for (const [key, value] of Object.entries(localStorage)) {
          if (!key.startsWith("pideck.draft.v1/")) continue;
          const saved = JSON.parse(value);
          if (saved.queueEdit?.id === Number(id) && saved.queueEdit.text === text && saved.text === draft) {
            return { key, token: saved.queueEdit.token };
          }
        }
      }, { id: targetId, text: editedText, draft: secondaryDraft }).then(handle => handle.jsonValue());
      async function expectResumedEdit(reason) {
        await waitForQueueEditor();
        const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), persisted.key);
        if (await queueEdit.inputValue() !== editedText || stored.queueEdit?.token !== persisted.token
          || stored.text !== secondaryDraft || await secondaryQueue.getByRole("listitem").count() !== 2
          || await secondaryQueue.locator(`[data-queue-id="${targetId}"]`).count() !== 1
          || await page.getByRole("article", { name: "You", exact: true }).getByText(suffix, { exact: true }).count()) {
          throw new Error(`${reason} did not preserve the edited text, token, ordinary draft and held queue.`);
        }
        if (await page.getByRole("button", { name: "Restore saved draft", exact: true }).count()) {
          throw new Error("Reopening an edit returned the removed recovery menu.");
        }
      }
      await page.reload();
      await expectResumedEdit("Reloading");
      const applicationUrl = page.url();
      // Replace the document and discard all window-only storage. Native smoke
      // separately verifies Electron window destruction and process restarts.
      await page.evaluate(() => sessionStorage.clear());
      await page.goto("about:blank");
      await page.goto(applicationUrl);
      await expectResumedEdit("Reopening with fresh window storage");
    }
    if (action === "save") await page.getByRole("button", { name: "Save queued message", exact: true }).click();
    else await queueEdit.press("Escape");
    await prompt.waitFor();
    await secondaryQueue.waitFor({ state: "detached" });
    const submitted = await page.getByRole("article", { name: "You", exact: true }).locator(".message-content").allTextContents();
    if (JSON.stringify(submitted.slice(-2).map(text => text.trim())) !== JSON.stringify([action === "save" ? editedText : target, suffix])
      || await prompt.inputValue() !== secondaryDraft) {
      throw new Error("Save/cancel did not release the queued messages in order while keeping the ordinary draft.");
    }
    if (await page.getByRole("button", { name: "Restore saved draft", exact: true }).count()
      || await page.getByRole("dialog", { name: "Saved drafts", exact: true }).count()) {
      throw new Error("The removed draft recovery menu returned during queue editing.");
    }
  }
  const currentRow = nav.locator(".nav-session-row[aria-current=true]");
  await currentRow.press("F2");
  const sessionName = page.getByRole("textbox", { name: "Session name", exact: true });
  await sessionName.fill("Separate draft");
  await sessionName.press("Enter");
  const draftSession = nav.getByRole("button", { name: "Separate draft", exact: true });
  await draftSession.waitFor();
  await prompt.fill("A separate draft.");
  await draftSession.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Queue next" }).waitFor();
  if (await page.locator('.chat-entry--assistant > .message-footer').count()) {
    throw new Error("A running tool message already shows AI message controls.");
  }
  if (await page.getByRole("button", { name: "Steer run", exact: true }).count()) throw new Error("The composer exposes a second send action.");
  const queue = page.getByRole("list", { name: "Queued messages" });
  const row = text => queue.getByRole("listitem").filter({ hasText: text });
  const queueActions = text => row(text).getByRole("group", { name: "Queued message actions", exact: true });
  const queueButton = (text, name) => queueActions(text).getByRole("button", { name, exact: true });
  const dragRow = text => row(text).locator(".queued-row");
  const dragSource = text => row(text).locator(".queued-message");
  async function dragMessage(text, targetText, position) {
    const target = dragRow(targetText);
    const { height } = await target.boundingBox();
    await dragSource(text).dragTo(target, {
      sourcePosition: { x: 14, y: 15 }, targetPosition: { x: 14, y: position === "before" ? 5 : height - 5 },
    });
  }
  for (const text of ["Prefer a focused check.", "Report the verification.", "Drop this duplicate.", "List follow-up work."]) {
    await prompt.fill(text);
    await prompt.press("Enter");
    await row(text).waitFor();
  }
  if (await queue.getByRole("button", { name: "Queued message actions", exact: true }).count()) {
    throw new Error("The queue still requires opening an actions menu.");
  }
  if (await queue.getByRole("button", { name: /^(Move up|Move down)$/ }).count()) {
    throw new Error("The queue still shows separate reorder buttons.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-running.png" });
  const queueViewport = page.viewportSize();
  await page.setViewportSize({ width: 760, height: 560 });
  const editableText = "Report the verification.";
  const narrowActions = queueActions(editableText);
  await narrowActions.scrollIntoViewIfNeeded();
  for (const name of ["Steer current run", "Edit message", "Delete message"]) {
    await queueButton(editableText, name).waitFor();
  }
  const inlineButtonsFit = await narrowActions.evaluate(group => {
    const preview = group.closest("li")?.querySelector(".queued-preview")?.getBoundingClientRect();
    const list = group.closest("ol")?.getBoundingClientRect();
    const buttons = [...group.querySelectorAll("button")].map(button => button.getBoundingClientRect());
    return preview && list && preview.width >= 40 && buttons.length === 3 && buttons.every((bounds, index) =>
      bounds.width >= 24 && bounds.height >= 24 && bounds.left >= preview.right - 1 && bounds.right <= innerWidth
        && bounds.top >= Math.max(0, list.top - 1) && bounds.bottom <= Math.min(innerHeight, list.bottom + 1)
        && bounds.top < preview.bottom && bounds.bottom > preview.top
        && (index === 0 || bounds.left >= buttons[index - 1].right - 1));
  });
  if (!inlineButtonsFit) throw new Error("Queue controls crowd the message or overflow the narrow window.");
  await page.screenshot({ path: "output/playwright/pideck-ui-queue-narrow.png" });
  const queueEditButton = queueButton(editableText, "Edit message");
  const parkedDraft = "Keep this ordinary unsent draft.";
  const waitingDuringEdit = "Another queue item waits while editing.";
  await prompt.fill(waitingDuringEdit);
  await prompt.press("Enter");
  await row(waitingDuringEdit).waitFor();
  await prompt.fill(parkedDraft);
  await pasteImage(2, 2);
  await attachmentPreview.waitFor();
  await queueEditButton.press("Enter");
  await waitForQueueEditor();
  if (await queueEdit.inputValue() !== editableText || !await queueEdit.evaluate(editor => editor === document.activeElement)
    || await composer.locator("textarea").count() !== 1 || await queue.locator("textarea").count()
    || await attachmentPreview.count()) {
    throw new Error("Queue editing did not reuse the focused composer and park ordinary draft attachments.");
  }
  if (!await page.getByRole("button", { name: "Save queued message", exact: true }).isEnabled()) {
    throw new Error("Saving unchanged queue text must still end its edit hold.");
  }
  const editMarker = queue.getByRole("status", { name: "Editing queued message", exact: true });
  const compactEditRow = queue.getByRole("listitem").filter({ has: page.getByRole("status", { name: "Editing queued message", exact: true }) });
  await editMarker.waitFor();
  if (await compactEditRow.getByText(editableText, { exact: true }).count() || await compactEditRow.getByRole("button").count()
    || await composer.getByText("Editing queued message", { exact: true }).count()) {
    throw new Error("The edited queue row repeats its message/actions or the composer repeats the editing label.");
  }
  await composer.getByRole("img", { name: "Editing queued message", exact: true }).waitFor();
  if (await queue.getByRole("group", { name: "Queued message actions", exact: true }).count()
    || await queue.locator('[draggable="true"]').count()) {
    throw new Error("The held queue exposes actions that cannot run until editing finishes.");
  }
  await queueEdit.focus();
  await page.screenshot({ path: "output/playwright/pideck-ui-queue-edit.png" });
  await appearance("light");
  await page.screenshot({ path: "output/playwright/pideck-ui-light-queue-edit.png" });
  await appearance("dark");
  await queueEdit.fill("An edit retained while switching sessions.");
  await page.waitForFunction(() => Object.entries(localStorage).some(([key, value]) => key.startsWith("pideck.draft.v1/")
    && JSON.parse(value).queueEdit?.text === "An edit retained while switching sessions."
    && JSON.parse(value).text === "Keep this ordinary unsent draft."));
  await page.setViewportSize(queueViewport);
  await draftSession.click();
  await prompt.waitFor();
  await runningSession.click();
  await waitForQueueEditor();
  if (await queueEdit.inputValue() !== "An edit retained while switching sessions.") throw new Error("Session switching lost the pending queue edit.");
  await queueEdit.press("Escape");
  await prompt.waitFor();
  await attachmentPreview.waitFor();
  if (await prompt.inputValue() !== parkedDraft || !await prompt.evaluate(editor => editor === document.activeElement)) {
    throw new Error("Cancelling the queue edit lost the parked draft or composer focus.");
  }
  for (const name of ["Steer current run", "Edit message", "Delete message"]) {
    await queueButton(waitingDuringEdit, name).waitFor();
  }
  if (await dragSource("Drop this duplicate.").getAttribute("draggable") !== "true") {
    throw new Error("Ending the queue edit did not restore dragging.");
  }
  await queueButton(waitingDuringEdit, "Delete message").click();
  await row(waitingDuringEdit).waitFor({ state: "detached" });
  await removeAttachment.click();
  await prompt.fill("");
  await page.setViewportSize({ width: 760, height: 560 });

  const extraRows = ["Scroll fixture one.", "Scroll fixture two.", "Scroll fixture three.", "Scroll fixture four."];
  for (const text of extraRows) {
    await prompt.fill(text);
    await prompt.press("Enter");
    await row(text).waitFor();
  }
  const lastText = extraRows.at(-1);
  const lastRow = dragSource(lastText);
  await lastRow.scrollIntoViewIfNeeded();
  if (!await queue.evaluate(list => list.scrollTop > 0)) throw new Error("The long queue is not scrolled.");
  const sourceBounds = await lastRow.boundingBox();
  const queueBounds = await queue.boundingBox();
  const dragX = sourceBounds.x + 14;
  await page.mouse.move(dragX, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(dragX, queueBounds.y + 7, { steps: 12 });
    await row(lastText).and(queue.locator('[data-dragging="true"]')).waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector(".queued-list").scrollTop <= 1);
    const firstBounds = await dragRow("Prefer a focused check.").boundingBox();
    await page.mouse.move(dragX, firstBounds.y + 5);
    await page.mouse.move(dragX + 2, firstBounds.y + 5);
    await row("Prefer a focused check.").and(queue.locator('[data-drop="before"]')).waitFor({ state: "attached" });
    await page.mouse.move(dragX + 2, firstBounds.y - 1);
    await page.mouse.move(dragX + 3, firstBounds.y - 1);
  } finally {
    await page.mouse.up();
  }
  await queue.getByRole("listitem").first().getByText(lastText, { exact: true }).waitFor();
  for (const text of extraRows) {
    await queueButton(text, "Delete message").click();
    await row(text).waitFor({ state: "detached" });
  }
  await page.setViewportSize(queueViewport);
  await prompt.fill(parkedDraft);
  await queueEditButton.click();
  await waitForQueueEditor();
  await queueEdit.fill("Report the final verification.");
  await page.getByRole("button", { name: "Save queued message", exact: true }).click();
  await row("Report the final verification.").waitFor();
  await prompt.waitFor();
  if (await prompt.inputValue() !== parkedDraft) throw new Error("Saving a queue edit replaced the ordinary unsent draft.");
  await prompt.fill("");
  const editedRow = dragSource("Report the final verification.");
  await editedRow.press("Alt+ArrowDown");
  await queue.getByRole("listitem").nth(2).getByText("Report the final verification.", { exact: true }).waitFor();
  if (!await editedRow.evaluate(element => element === document.activeElement)) throw new Error("Reordering lost the focused message.");
  await editedRow.press("Alt+ArrowUp");
  await queue.getByRole("listitem").nth(1).getByText("Report the final verification.", { exact: true }).waitFor();
  await dragMessage("Report the final verification.", "Report the final verification.", "before");
  await prompt.fill("Keep this unsent draft.");
  await editedRow.dragTo(prompt, { sourcePosition: { x: 14, y: 15 } });
  if (await prompt.inputValue() !== "Keep this unsent draft.") throw new Error("A canceled queue drag changed the draft.");
  await prompt.fill("");
  await dragMessage("Report the final verification.", "Drop this duplicate.", "after");
  await queue.getByRole("listitem").nth(2).getByText("Report the final verification.", { exact: true }).waitFor();
  await queueButton("Drop this duplicate.", "Delete message").press("Enter");
  await row("Drop this duplicate.").waitFor({ state: "detached" });
  if (!await queueButton("Report the final verification.", "Edit message").evaluate(button => button === document.activeElement)) {
    throw new Error("Deleting a queued message lost keyboard focus.");
  }
  await dragMessage("List follow-up work.", "Report the final verification.", "before");
  await queue.getByRole("listitem").nth(1).getByText("List follow-up work.", { exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "output/playwright/pideck-ui-queue.png" });
  const steer = queueButton("Prefer a focused check.", "Steer current run");
  await steer.press("Enter");
  await row("Prefer a focused check.").getByText("Steering", { exact: true }).waitFor();
  if (!await queueButton("Prefer a focused check.", "Edit message").evaluate(button => button === document.activeElement)) {
    throw new Error("Steering a queued message lost keyboard focus.");
  }
  if (await steer.count() && await steer.isEnabled()) throw new Error("A steering message still offers Steer.");
  await dragMessage("List follow-up work.", "Prefer a focused check.", "before");
  await queue.getByRole("listitem").nth(0).getByText("Prefer a focused check.", { exact: true }).waitFor();
  await queue.getByRole("listitem").nth(1).getByText("List follow-up work.", { exact: true }).waitFor();
  if (await page.locator(".queued-messages [role=alert]").count()) throw new Error("An invalid drop reached the host.");
  const successfulCommand = page.locator(".tool-card summary").filter({ hasText: "npm test" });
  if (await page.locator(".message-duration").count()) throw new Error("A running interaction already displays a completed working time.");
  await successfulCommand.press("Enter");
  await page.getByText("Running the status check…", { exact: true }).waitFor({ state: "hidden" });
  await successfulCommand.press("Enter");
  await page.getByText("Running the status check…", { exact: true }).waitFor();
  await checkAssistantFooter('tools');
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-write-result")));
  await page.getByRole("status").getByText("Writing response…", { exact: true }).waitFor();
  await page.locator(".tool-output").filter({ hasText: "Verified step 8." }).waitFor();
  await checkAssistantFooter('mixed');
  await page.setViewportSize({ width: queueViewport.width, height: 420 });
  const transcript = page.locator(".chat-scroll");
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".chat-scroll");
    return scroll.clientHeight > 40 && scroll.scrollHeight - scroll.clientHeight > 48 && scroll.scrollTop > 0;
  });
  await transcript.hover();
  await page.mouse.wheel(0, -1000);
  await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    const id = preferences.sessions?.[preferences.projectId];
    return preferences.reading?.[preferences.projectId]?.[id]?.messageId === "prompt";
  });
  await prompt.fill(parkedDraft);
  await draftSession.click();
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-queue")));
  const finishedBadge = runningSession.locator("[data-activity=finished]");
  await finishedBadge.locator("svg.lucide-check").waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-background.png" });
  await runningSession.click();
  await page.getByText("I updated the status and checked the result.").waitFor({ state: "attached" });
  await prompt.waitFor();
  if (await prompt.inputValue() !== parkedDraft || await queueEdit.count() || await queue.count()
    || await page.getByRole("button", { name: "Save queued message", exact: true }).count()) {
    throw new Error("A fully consumed queue left Queued0, a stale editor, or replaced the parked draft.");
  }
  if (await page.getByRole("button", { name: "Restore saved draft", exact: true }).count()
    || await page.getByRole("dialog", { name: "Saved drafts", exact: true }).count()) {
    throw new Error("Finishing queued work exposed the removed draft recovery controls.");
  }
  await prompt.fill("");
  const latest = page.getByRole("button", { name: "Latest", exact: true });
  await latest.waitFor();
  if (!await finishedBadge.count()) throw new Error("Opening at an old reading position cleared the unseen result.");
  await latest.click();
  await finishedBadge.waitFor({ state: "detached" });
  await page.setViewportSize(queueViewport);
  const successOutput = page.getByText("Checks passed.", { exact: true });
  await successfulCommand.getByRole("status", { name: "Succeeded", exact: true }).waitFor();
  await successOutput.waitFor();
  await page.getByText("Lint reported an error.", { exact: true }).waitFor();
  const smallDiff = page.locator(".tool-card").filter({ has: page.locator("summary").filter({ hasText: "example.ts" }) });
  await smallDiff.locator(".workspace-inline [data-diff-type=single]").waitFor();
  if (await smallDiff.getByRole("button", { name: "Open in Changes", exact: true }).count()) {
    throw new Error("A complete small inline diff still opens a duplicate review.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-tool-logs.png" });
  await successfulCommand.press("Enter");
  await successOutput.waitFor({ state: "hidden" });
  await successfulCommand.press("Enter");
  await successOutput.waitFor();
  if ((await page.locator("#rename-current-session").textContent()).trim() !== (await runningSession.textContent()).trim()) {
    throw new Error("The titlebar does not identify the current session with the sidebar open.");
  }
  await runningSession.dblclick();
  await sessionName.fill("Status review");
  await sessionName.press("Enter");
  await page.getByRole("button", { name: "Rename session Status review", exact: true }).click();
  await sessionName.fill("Verify status");
  await sessionName.press("Enter");
  await page.getByRole("button", { name: "Rename session Verify status", exact: true }).waitFor();

  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await page.getByText("An earlier coding request.").waitFor();
  if (await page.getByRole("button", { name: "Summarize context" }).count()) {
    throw new Error("The title bar still exposes manual context compaction.");
  }
  const userMessage = page.getByRole("article", { name: "You", exact: true }).filter({ hasText: "Update and verify the status." });
  const assistantMessage = page.getByRole("article", { name: "Pideck", exact: true }).filter({ hasText: "I updated the status and checked the result." });
  await checkAssistantFooter('finished');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-next-run', { detail: true })));
  await page.getByText('Checking the next request…', { exact: true }).waitFor();
  if (await page.locator('.chat-entry--assistant > .message-footer').count() !== 1
    || await assistantMessage.locator('.message-footer').count() !== 1
    || await page.locator('[data-message-id="live-assistant"] .message-footer').count()) {
    throw new Error('Starting another run must retain the previous final footer without adding live controls.');
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pideck-fixture-next-run', { detail: false })));
  await page.getByText('Checking the next request…', { exact: true }).waitFor({ state: 'detached' });
  await checkNativeRunControls();
  if (await assistantMessage.getByRole("link", { name: "Unsafe link", exact: true }).count()
    || await assistantMessage.getByRole("link", { name: "Outside file", exact: true }).count()) {
    throw new Error("Unsafe schemes or paths outside the project became clickable message links.");
  }
  const messageUrl = page.url();
  await assistantMessage.getByRole("link", { name: "Node docs", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.openedExternalLink === "https://nodejs.org/api/assert.html");
  if (page.url() !== messageUrl) throw new Error("An external message link navigated the privileged renderer.");
  await page.evaluate(() => sessionStorage.setItem("pideck-extra-review-file", "1"));
  const linkedReview = page.getByRole("complementary", { name: "Review changes" });
  for (const name of ["Review source", "Project source"]) {
    await assistantMessage.getByRole("link", { name, exact: true }).click();
    await linkedReview.waitFor();
    await linkedReview.locator('[aria-current="true"]').filter({ hasText: "example.ts" }).waitFor();
    await linkedReview.locator('[data-selected-line]').first().waitFor();
    if (await linkedReview.getByText("From chat", { exact: true }).count()) throw new Error("A project file link opened a saved tool patch instead of the current file.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-linked-file.png" });
  await assistantMessage.getByRole("link", { name: "Project guide", exact: true }).click();
  const filePreview = linkedReview.locator('[data-file-preview="README.md"]');
  await filePreview.filter({ hasText: "Read-only project documentation." }).waitFor();
  if (await linkedReview.getByText("This file has no current Git changes.", { exact: true }).count()) {
    throw new Error("An unchanged project link stopped at an empty diff instead of showing its file.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-file-preview.png" });
  await appearance("light");
  await filePreview.filter({ hasText: "Read-only project documentation." }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-light-file-preview.png" });
  await appearance("dark");
  await filePreview.hover();
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => document.querySelector('[data-file-preview="README.md"]')?.scrollTop > 300);
  const previewPosition = await filePreview.evaluate(element => element.scrollTop);
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await appearance(theme);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await filePreview.waitFor();
    await page.waitForFunction(position => {
      const preview = document.querySelector('[data-file-preview="README.md"]');
      return preview && Math.abs(preview.scrollTop - position) <= 2;
    }, previewPosition);
  }
  await assistantMessage.getByRole("link", { name: "Unchanged line", exact: true }).click();
  const unchangedLinePreview = linkedReview.locator('[data-file-preview="example.ts"]');
  await unchangedLinePreview.filter({ hasText: "export const line30 = 30;" }).waitFor();
  await unchangedLinePreview.locator('[data-selected-line]').first().waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-linked-file.png" });
  await unchangedLinePreview.hover();
  await page.mouse.wheel(0, -2_000);
  await page.waitForFunction(() => document.querySelector('[data-file-preview="example.ts"]')?.scrollTop === 0);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await appearance("light");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await linkedReview.locator('[data-file-preview="example.ts"][aria-busy="false"]').waitFor();
  await unchangedLinePreview.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await unchangedLinePreview.evaluate(element => element.scrollTop) !== 0) {
    throw new Error("Returning to a file preview jumped back to its old line link instead of preserving the reading position.");
  }
  await unchangedLinePreview.hover();
  await page.mouse.wheel(0, 450);
  await unchangedLinePreview.locator('[data-selected-line][data-line="30"]').waitFor();
  await appearance("dark");
  const beforeWrappedViewport = page.viewportSize();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => sessionStorage.setItem("pideck-review-wrapped-guide", "1"));
  await assistantMessage.getByRole("link", { name: "Project guide", exact: true }).click();
  await linkedReview.locator('[data-file-preview="README.md"][aria-busy="false"]').waitFor();
  const wrappedBounds = await filePreview.boundingBox();
  const wrappedDivider = page.getByRole("separator", { name: "Resize right sidebar", exact: true });
  const dividerBounds = await wrappedDivider.boundingBox();
  await page.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(dividerBounds.x + dividerBounds.width / 2 - (447 - wrappedBounds.width), dividerBounds.y + 30);
  await page.mouse.up();
  await filePreview.hover();
  await page.mouse.wheel(0, -10_000);
  await filePreview.filter({ hasText: "Pideck Final Review" }).waitFor();
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => document.querySelector('[data-file-preview="README.md"]')?.scrollTop >= 650);
  await filePreview.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  function previewReadingAnchor(root) {
    const edge = root.getBoundingClientRect().top;
    const rows = [...root.querySelectorAll("diffs-container")].flatMap(host => [...host.shadowRoot.querySelectorAll("[data-line]")]);
    const row = rows.find(row => row.getBoundingClientRect().top >= edge - 1 && row.getBoundingClientRect().bottom > edge + 1);
    const heights = rows.map(row => row.getBoundingClientRect().height).filter(height => height > 0);
    return { line: row?.getAttribute("data-line"), offset: row?.getBoundingClientRect().top - edge,
      wrapped: Math.max(...heights) > Math.min(...heights) + 1 };
  }
  let wrappedAnchor = await filePreview.evaluate(previewReadingAnchor);
  if (!wrappedAnchor.line || !wrappedAnchor.wrapped) throw new Error("The reading-position fixture did not produce wrapped source lines.");
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await appearance(theme);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.waitForFunction(target => {
      const root = document.querySelector('[data-file-preview="README.md"]');
      if (!root) return false;
      const edge = root.getBoundingClientRect().top;
      const rows = [...root.querySelectorAll("diffs-container")].flatMap(host => [...host.shadowRoot.querySelectorAll("[data-line]")]);
      const row = rows.find(row => row.getBoundingClientRect().top >= edge - 1 && row.getBoundingClientRect().bottom > edge + 1);
      return row?.getAttribute("data-line") === target.line && Math.abs(row.getBoundingClientRect().top - edge - target.offset) <= 2;
    }, wrappedAnchor);
    await filePreview.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const restoredAnchor = await filePreview.evaluate(previewReadingAnchor);
    if (restoredAnchor.line !== wrappedAnchor.line || Math.abs(restoredAnchor.offset - wrappedAnchor.offset) > 2) {
      throw new Error("Wrapped file content moved after changing appearance in Terminal.");
    }
    if (theme === "light") {
      const top = await filePreview.evaluate(element => element.scrollTop);
      await filePreview.hover();
      await page.mouse.wheel(0, 180);
      await page.waitForFunction(previous => document.querySelector('[data-file-preview="README.md"]').scrollTop > previous + 100, top);
      await filePreview.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      wrappedAnchor = await filePreview.evaluate(previewReadingAnchor);
    }
  }
  await wrappedDivider.press("Enter");
  await page.evaluate(() => sessionStorage.removeItem("pideck-review-wrapped-guide"));
  if (beforeWrappedViewport) await page.setViewportSize(beforeWrappedViewport);
  await linkedReview.getByRole("button", { name: /example\.ts/ }).click();
  await linkedReview.locator('[data-file-preview]').waitFor({ state: "detached" });
  await linkedReview.locator('[data-selected-line]').first().waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.evaluate(() => sessionStorage.removeItem("pideck-extra-review-file"));
  async function expectTranscriptLayout() {
    if (await userMessage.getByText("You", { exact: true }).count() || await assistantMessage.getByText("Pideck", { exact: true }).count()) {
      throw new Error("The transcript still displays speaker labels.");
    }
    const aligned = await page.locator(".chat-thread").evaluate(thread => {
      const column = thread.getBoundingClientRect();
      const user = thread.querySelector(".chat-entry--user").getBoundingClientRect();
      const assistant = thread.querySelector(".chat-entry--assistant").getBoundingClientRect();
      const leftAligned = content => ["start", "left"].includes(getComputedStyle(content).textAlign);
      return Math.abs(user.right - column.right) <= 1 && user.width <= column.width * 0.8
        && Math.abs(assistant.left - column.left) <= 1
        && [...thread.querySelectorAll(".message-content")].every(leftAligned);
    });
    if (!aligned) throw new Error("User messages should sit on the right and assistant output should start on the left.");
  }
  await expectTranscriptLayout();
  await expectColors(userMessage.locator(".message-content"), { "background-color": inputSurface, "border-width": "0px" });
  for (const [message, timestamp] of [[userMessage, Date.parse("2026-11-07T05:04:00Z")],
    [assistantMessage, Date.parse("2026-11-07T05:05:35Z")]]) {
    const time = message.locator(".message-footer time");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test((await time.textContent()).trim())
      || await time.getAttribute("datetime") !== new Date(timestamp).toISOString()) {
      throw new Error("Message timestamps must retain their source time and display only 24-hour HH:mm.");
    }
    if (!await message.evaluate(article => {
      const content = article.querySelector(".message-content").getBoundingClientRect();
      const footer = article.querySelector(".message-footer").getBoundingClientRect();
      return footer.top >= content.bottom - 1;
    })) throw new Error("Message controls and timestamp do not sit on a separate row below the content.");
    await message.getByRole("button", { name: "Copy message", exact: true }).click();
    await message.getByRole("button", { name: "Message copied", exact: true }).waitFor();
    const copied = await page.evaluate(() => document.body.dataset.copiedText);
    if (copied?.includes('"command":') || copied?.includes('"path":')) {
      throw new Error("Copying visible output should not include serialized tool arguments.");
    }
    if (message === userMessage ? copied !== "Update and verify the status."
      : !copied?.includes("I updated the status and checked the result.") || !copied.includes("Checks passed.") || copied.includes("Worked for")) {
      throw new Error("Copying a message included controls or lost its text/tool result.");
    }
  }
  if (await page.locator(".message-duration").count()) throw new Error("Duration must stay out of the message footer.");
  await page.locator(".run-clock[data-ended-at]").waitFor();
  const retainedClock = await runClock();
  if (retainedClock.endedAt === undefined) throw new Error("The completed conversation lost its frozen total.");
  for (const theme of ["light", "dark"]) {
    await appearance(theme);
    await userMessage.getByRole("button", { name: "Copy message", exact: true }).waitFor();
    if (await page.locator('.chat-entry--user .message-footer button:not(.message-copy)').count()
      || await page.getByRole('textbox', { name: 'Edit sent message', exact: true }).count()) {
      throw new Error('Committed user messages must expose Copy only, without editing or automatic branching.');
    }
    await expectVisibleMetadata(userMessage);
    await expectVisibleMetadata(assistantMessage);
    await userMessage.screenshot({ path: `output/playwright/pideck-footer-user-${theme}.png` });
  }
  await userMessage.hover();
  if (await page.getByRole("article", { name: "You", exact: true })
    .getByRole("button", { name: "Branch from here" }).count()) {
    throw new Error("User messages, including earlier history, should not expose a branch action.");
  }
  const branchMessage = assistantMessage.getByRole("button", { name: "Branch from here" });
  await prompt.focus();
  await page.mouse.move(0, 0);
  if (!await branchMessage.evaluate(button => Boolean(button.closest(".message-footer"))
    && getComputedStyle(button).opacity === "1" && !button.textContent.trim() && Boolean(button.querySelector("svg")))) {
    throw new Error("Message actions must stay visible outside hover or focus, retaining their icon-only layout.");
  }
  await branchMessage.focus();
  if (await branchMessage.evaluate(button => getComputedStyle(button).opacity) !== "1") {
    throw new Error("The message branch action did not stay visible on keyboard focus.");
  }
  await branchMessage.press("Enter");
  const forked = nav.getByRole("button", { name: "Verify status (fork)", exact: true });
  const original = nav.getByRole("button", { name: "Verify status", exact: true });
  await forked.waitFor();
  if (await original.locator('..').locator('.nav-disclosure').count()
    || !await forked.locator('..').locator('.nav-session-guides').isVisible()) {
    throw new Error('Creating a fork must add a tree guide without adding a collapse control to the source.');
  }
  await original.click();
  await page.getByText("An earlier coding request.").waitFor();
  const resumeViewport = page.viewportSize();
  await page.setViewportSize({ width: resumeViewport.width, height: 300 });
  await smallDiff.locator(".workspace-inline [data-diff-type=single]").waitFor();
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".chat-scroll");
    return scroll.scrollHeight - scroll.clientHeight > 80;
  });
  await transcript.hover({ position: { x: 8, y: 40 } });
  await page.mouse.wheel(0, -1000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.wheel(0, -1000);
  const position = await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    const id = preferences.sessions?.[preferences.projectId];
    return preferences.reading?.[preferences.projectId]?.[id];
  }).then(handle => handle.jsonValue()).catch(async cause => {
    const geometry = await transcript.evaluate(scroll => [scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight]);
    throw new Error(`The transcript did not save its reading position at ${geometry.join("/")}: ${cause.message}`);
  });
  await prompt.fill("Continue this after restarting.");
  await page.reload();
  await page.getByText("I updated the status and checked the result.").waitFor();
  if (await original.getAttribute("aria-current") !== "true") throw new Error("Session selection did not survive reload.");
  if (await prompt.inputValue() !== "Continue this after restarting.") throw new Error("Draft did not survive reload.");
  await page.waitForFunction(({ messageId, offset }) => {
    const scroll = document.querySelector(".chat-scroll");
    const anchor = scroll?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    return anchor && Math.abs(anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset) <= 2;
  }, position);
  await draftSession.click();
  await page.waitForFunction(() => document.querySelector("#prompt").value === "A separate draft.");
  await page.setViewportSize(resumeViewport);
  await page.evaluate(() => sessionStorage.setItem("pideck-extra-review-file", "1"));
  const changeButton = page.getByRole("button", { name: "Changes", exact: true });
  await changeButton.click();
  const extraFile = page.getByRole("button", { name: /second\.ts/ });
  await extraFile.click();
  await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem("pideck.workspace.v1")).reviewPaths).includes("second.ts"));
  await page.reload();
  await changeButton.click();
  await page.locator('#review-panel [aria-current="true"]').filter({ hasText: "second.ts" }).waitFor();
  if (await page.locator("#review-panel .workspace-diff-header").count()) {
    throw new Error("The review repeats the name of the selected file.");
  }
  await changeButton.click();
  await page.evaluate(() => sessionStorage.removeItem("pideck-extra-review-file"));
  await forked.click();
  await smallDiff.locator(".workspace-inline [data-diff-type=single]").waitFor();

  const changes = page.getByRole("button", { name: "Changes", exact: true });
  const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
  const sidebar = page.locator("#toggle-navigation");
  for (const toggle of [sidebar, changes, terminalToggle]) {
    if (!await toggle.evaluate(button => !button.textContent.trim() && Boolean(button.title && button.querySelector("svg")))) {
      throw new Error("A workspace toggle needs a visible icon and a tooltip.");
    }
  }
  const selectedToggleColors = {
    "background-color": "rgba(255, 255, 255, 0.08)",
    "color": foreground,
    "border-top-color": "rgba(0, 0, 0, 0)",
  };
  const terminal = page.getByRole("region", { name: "Project terminal" });
  const restartShell = terminal.getByRole("button", { name: "Restart shell", exact: true });
  const shellRunning = terminal.getByText("Shell running", { exact: true });
  const tools = page.locator("#workspace-tools");
  const screen = terminal.locator(".xterm-helper-textarea");
  const divider = page.getByRole("separator", { name: "Resize right sidebar" });
  const togglePositions = async () => Promise.all([changes, terminalToggle].map(async button => (await button.boundingBox()).x));
  const expectTogglePositions = async expected => {
    if ((await togglePositions()).some((position, index) => Math.abs(position - expected[index]) > 1)) {
      throw new Error("Switching the right panel moved the workspace toggles.");
    }
  };
  const expectTerminalToolbar = async () => {
    const [restart, panelToggle] = await Promise.all([restartShell.boundingBox(), changes.boundingBox()]);
    if (await terminal.getByRole("searchbox").count() || await terminal.getByRole("button", { name: /Find in terminal/ }).count()
      || !restart || !panelToggle || restart.y < panelToggle.y + panelToggle.height
      || !await restartShell.evaluate(button => !button.textContent.trim() && Boolean(button.title && button.querySelector("svg")))) {
      throw new Error("Terminal should keep its compact restart icon below the fixed global toggles, with no search controls.");
    }
  };
  const review = page.getByRole("complementary", { name: "Review changes" });
  const expectToolbarEdge = async () => {
    const aligned = await page.evaluate(() => {
      const middleHeader = document.querySelector(".titlebar-content");
      const middleEdge = window.innerWidth;
      const header = middleHeader;
      const changesButton = document.getElementById("toggle-review");
      const terminalButton = document.getElementById("toggle-terminal");
      const changes = changesButton.getBoundingClientRect();
      const terminal = terminalButton.getBoundingClientRect();
      const edge = header.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(header).paddingInlineEnd);
      const otherControls = [...header.querySelectorAll("h2, button, input, select")]
        .filter(control => !control.closest('[aria-label="Workspace panels"]') && control.getClientRects().length);
      return document.querySelectorAll("#toggle-review").length === 1 && document.querySelectorAll("#toggle-terminal").length === 1
        && header.contains(changesButton) && header.contains(terminalButton)
        && Math.abs(middleHeader.getBoundingClientRect().right - middleEdge) <= 1
        && changes.right <= terminal.left && Math.abs(terminal.right - (edge.right - inset)) <= 1
        && Math.abs((terminal.top + terminal.bottom) / 2 - (edge.top + edge.bottom) / 2) <= 1
        && otherControls.every(control => control.getBoundingClientRect().right <= changes.left + 1);
    });
    if (!aligned) throw new Error("The workspace toggles must appear once at the global titlebar's right edge, without overlapping its other controls.");
  };
  const expectActiveTool = async (active) => {
    await review.waitFor({ state: active === "changes" ? "visible" : "hidden" });
    await terminal.waitFor({ state: active === "terminal" ? "visible" : "hidden" });
    await tools.waitFor({ state: active ? "visible" : "hidden" });
    if (await changes.getAttribute("aria-pressed") !== String(active === "changes")
      || await terminalToggle.getAttribute("aria-pressed") !== String(active === "terminal")) {
      throw new Error("The right sidebar buttons do not match the active tool.");
    }
    if (!active && !await page.locator(".workspace-conversation").evaluate(conversation =>
      Math.abs(conversation.getBoundingClientRect().right - window.innerWidth) <= 1)) {
      throw new Error("Collapsing the right sidebar did not return its space to the conversation.");
    }
    await expectToolbarEdge();
  };
  await expectActiveTool();
  await page.screenshot({ path: "output/playwright/pideck-ui-conversation.png" });
  await page.evaluate(() => {
    sessionStorage.setItem("pideck-review-list-failure", "1");
    window.dispatchEvent(new Event("pideck-fixture-review-change"));
  });
  await changes.click();
  const retry = review.getByRole("button", { name: "Retry", exact: true });
  const clearReviewErrorAndRetry = key => retry.evaluate((button, storageKey) => {
    sessionStorage.removeItem(storageKey);
    button.click();
  }, key);
  await clearReviewErrorAndRetry("pideck-review-list-failure");
  const layout = review.getByRole("combobox", { name: "Diff layout" });
  const singleDiff = review.locator("diffs-container [data-diff-type=single]").first();
  const splitDiff = review.locator("diffs-container [data-diff-type=split]").first();
  await singleDiff.waitFor();
  await review.getByRole("button", { name: /Refresh/i }).waitFor({ state: "hidden" });
  await page.evaluate(() => {
    sessionStorage.setItem("pideck-review-patch-failure", "1");
    window.dispatchEvent(new Event("pideck-fixture-review-change"));
  });
  await clearReviewErrorAndRetry("pideck-review-patch-failure");
  await retry.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    sessionStorage.setItem("pideck-review-edit", "1");
    window.dispatchEvent(new Event("pideck-fixture-review-change"));
  });
  await singleDiff.getByText("updated", { exact: false }).waitFor();
  await page.evaluate(() => sessionStorage.removeItem("pideck-review-edit"));
  await tools.locator(".workspace-review").waitFor();
  const toolsWidthBefore = (await tools.boundingBox()).width;
  await divider.press("Shift+ArrowLeft");
  await page.waitForFunction(width => document.getElementById("workspace-tools").getBoundingClientRect().width > width + 20, toolsWidthBefore);
  const resizedWidth = (await tools.boundingBox()).width;
  const resizedTogglePositions = await togglePositions();
  await changes.click();
  await expectActiveTool();
  await changes.click();
  await expectActiveTool("changes");
  await expectTogglePositions(resizedTogglePositions);
  if (Math.abs((await tools.boundingBox()).width - resizedWidth) > 1) throw new Error("Reopening reset the sidebar width.");
  await divider.press("Enter");
  await page.waitForFunction(width => Math.abs(document.getElementById("workspace-tools").getBoundingClientRect().width - width) < 2, toolsWidthBefore);
  if (await layout.inputValue() !== "auto") throw new Error("Diff layout does not start in Auto.");
  await layout.selectOption("split");
  await splitDiff.waitFor();
  await layout.selectOption("auto");
  await singleDiff.waitFor();
  if (await review.getByRole("button", { name: "Back to chat" }).count()) throw new Error("Wide review has a duplicate close action.");
  const viewport = page.viewportSize();
  const expectDockedTool = async (pane) => {
    const aligned = await page.evaluate(pane => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      const centerX = selector => { const rect = bounds(selector); return rect.left + rect.width / 2; };
      const sameEdge = (first, second) => Math.abs(first - second) <= 1;
      const sidebarEdge = bounds(".navigation").right;
      const titlebar = bounds(".titlebar");
      const middleHeader = bounds(".titlebar-content");
      const sessionTitle = bounds(".workspace-title");
      const right = bounds("#workspace-tools[data-docked]");
      const conversation = bounds(".workspace-conversation");
      const panel = bounds(pane);
      const panelHeader = bounds(pane + " .workspace-panel-header");
      return sameEdge(bounds(".titlebar-leading").right, sidebarEdge)
        && sameEdge(centerX("#toggle-navigation"), centerX("#nav-open-project"))
        && sameEdge(conversation.left, sidebarEdge)
        && sameEdge(conversation.right, right.left)
        && sameEdge(bounds(".chat-thread").left, bounds(".composer").left)
        && sameEdge(middleHeader.left, sidebarEdge)
        && sameEdge(middleHeader.right, titlebar.right)
        && sessionTitle.left - middleHeader.left <= 24 && sessionTitle.left > middleHeader.left
        && sessionTitle.right <= middleHeader.right
        && sameEdge(panel.top, titlebar.bottom) && panelHeader.bottom > titlebar.bottom
        && sameEdge(panel.left, right.left) && sameEdge(panel.right, right.right)
        && sameEdge(panel.bottom, right.bottom);
    }, pane);
    if (!aligned) throw new Error("The active tool must fill the right sidebar beside the middle header.");
  };
  await expectActiveTool("changes");
  await expectDockedTool("#review-panel");
  const dockedTogglePositions = await togglePositions();
  if (await tools.locator("[role=separator]").count()) throw new Error("The right sidebar still splits tools vertically.");
  await expectColors(page.locator(".titlebar"), { "background-color": canvas });
  for (const surface of [page.locator(".titlebar-leading"), nav, review,
    review.locator(".workspace-panel-header"), review.locator(".workspace-review-scroll")]) {
    await expectColors(surface, { "background-color": panel });
  }
  const selectedSession = nav.locator('.nav-session-row[aria-current="true"]');
  await expectColors(selectedSession, { "background-color": "rgb(56, 56, 56)" });
  await selectedSession.hover();
  await expectColors(selectedSession, { "background-color": "rgb(56, 56, 56)", "color": foreground });
  for (const toggle of [sidebar, changes]) {
    await expectColors(toggle, selectedToggleColors);
    await toggle.hover();
    await expectColors(toggle, selectedToggleColors);
  }
  await prompt.hover();
  await expectColors(singleDiff.locator('[data-line-type="change-addition"] [data-diff-span]').first(), {
    "background-color": "rgba(46, 160, 67, 0.4)",
  });
  await expectColors(singleDiff.locator('[data-line-type="change-deletion"] [data-diff-span]').first(), {
    "background-color": "rgba(248, 81, 73, 0.4)",
  });
  await divider.blur();
  await page.screenshot({ path: "output/playwright/pideck-ui-workspace.png" });
  await terminalToggle.click();
  await terminal.getByText("Shell running").waitFor();
  await expectActiveTool("terminal");
  await expectDockedTool("#workspace-terminal");
  await expectTogglePositions(dockedTogglePositions);
  await expectColors(terminalToggle, selectedToggleColors);
  await expectTerminalToolbar();
  const liveShell = await page.evaluate(() => document.body.dataset.terminalId);
  await screen.evaluate(element => { element.dataset.workspaceFixture = "same"; });
  const expectSameShell = async () => {
    if (await tools.locator('.xterm-helper-textarea[data-workspace-fixture="same"]').count() !== 1
      || await page.evaluate(() => document.body.dataset.terminalId) !== liveShell) {
      throw new Error("Switching or collapsing the right sidebar replaced the live terminal.");
    }
  };
  await page.screenshot({ path: "output/playwright/pideck-ui-right-sidebar.png" });
  await changes.click();
  await expectActiveTool("changes");
  await expectTogglePositions(dockedTogglePositions);
  await expectSameShell();
  await changes.click();
  await expectActiveTool();
  await expectSameShell();
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await expectSameShell();
  await terminalToggle.click();
  await expectActiveTool();
  await expectSameShell();
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await expectSameShell();
  await changes.click();
  await expectActiveTool("changes");
  await page.setViewportSize({ width: 1920, height: 960 });
  await splitDiff.waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-wide.png" });
  await page.setViewportSize({ width: 1045, height: 680 });
  const back = review.getByRole("button", { name: "Back to chat" });
  await nav.waitFor();
  await divider.waitFor();
  await back.waitFor({ state: "hidden" });
  await expectToolbarEdge();
  if (!await prompt.isVisible() || await prompt.evaluate(input => Boolean(input.closest("[inert]")))) {
    throw new Error("Changes covered the composer at an intermediate window width.");
  }
  await page.setViewportSize({ width: 940, height: 680 });
  await nav.waitFor({ state: "detached" });
  await divider.waitFor();
  await back.waitFor({ state: "hidden" });
  await expectToolbarEdge();
  await page.setViewportSize({ width: 760, height: 560 });
  await page.waitForFunction(() => document.querySelector(".workspace-conversation").inert
    && document.querySelector("#review-panel").contains(document.activeElement));
  await back.waitFor();
  await nav.waitFor({ state: "detached" });
  await changes.waitFor();
  await terminalToggle.waitFor();
  await expectActiveTool("changes");
  await divider.waitFor({ state: "hidden" });
  const reviewWidth = await review.evaluate(panel => panel.getBoundingClientRect().width);
  if (reviewWidth < 755) throw new Error("The compact review does not use the full window.");
  const compactTogglePositions = await togglePositions();
  await page.getByRole("button", { name: "Rename session Verify status (fork)", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-narrow.png" });
  await back.click();
  await expectActiveTool();
  await expectTogglePositions(compactTogglePositions);
  await page.waitForFunction(() => !document.querySelector(".workspace-conversation").inert
    && document.activeElement?.id === "toggle-review");
  await expectTranscriptLayout();
  await model.click();
  await modelSearch.waitFor();
  const compactMenuFits = await picker.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    return bounds.top >= 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  });
  if (!compactMenuFits) throw new Error("The model dropdown overflows a narrow window.");
  await page.locator(".titlebar").click({ position: { x: 380, y: 25 } });
  await picker.waitFor({ state: "hidden" });
  await sidebar.press("Enter");
  await nav.waitFor();
  await page.waitForFunction(() => document.querySelector(".workspace").inert
    && document.activeElement?.id.startsWith("nav-session-"));
  const compactToggleAligned = await page.evaluate(() => {
    const centerX = id => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.left + rect.width / 2; };
    return Math.abs(centerX("toggle-navigation") - centerX("nav-open-project")) <= 1;
  });
  if (!compactToggleAligned) throw new Error("The compact sidebar toggle does not align with Open folder.");
  if (await page.locator(".workspace").evaluate(panel => panel.getBoundingClientRect().width) !== 760) throw new Error("Compact sidebar squeezed the workspace.");
  await page.screenshot({ path: "output/playwright/pideck-ui-sidebar.png" });
  await page.keyboard.press("Escape");
  await nav.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.id === "toggle-navigation");
  if (await sidebar.getAttribute("aria-label") !== "Show sidebar") throw new Error("The closed sidebar cannot be reopened by its toggle.");
  await sidebar.click();
  await nav.waitFor();
  await terminalToggle.click();
  await nav.waitFor({ state: "detached" });
  await terminal.getByText("Shell running").waitFor();
  await expectActiveTool("terminal");
  await expectColors(terminalToggle, selectedToggleColors);
  await expectTerminalToolbar();
  await screen.waitFor();
  const terminalBack = terminal.getByRole("button", { name: "Back to chat" });
  await terminalBack.waitFor();
  if ((await terminal.boundingBox()).width < 755 || await tools.getAttribute("data-docked") !== null) {
    throw new Error("The compact terminal does not use the full workspace.");
  }
  for (const surface of [terminal, terminal.locator(".workspace-panel-header"),
    terminal.locator(".xterm"), terminal.locator(".xterm-scrollable-element")]) {
    await expectColors(surface, { "background-color": panel });
  }
  await changes.click();
  await back.waitFor();
  await expectActiveTool("changes");
  await expectTogglePositions(compactTogglePositions);
  await expectSameShell();
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await expectTogglePositions(compactTogglePositions);
  await expectSameShell();
  await page.screenshot({ path: "output/playwright/pideck-ui-terminal.png" });
  await terminalBack.click();
  await expectActiveTool();
  await expectSameShell();
  await page.waitForFunction(() => !document.querySelector(".workspace-conversation").inert
    && document.activeElement?.id === "toggle-terminal");
  await page.setViewportSize(viewport);
  const largeDiff = page.getByRole("button", { name: "Open in Changes", exact: true });
  const chatPatch = review.getByTitle("Patch from chat for second.ts");
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await largeDiff.click();
  await chatPatch.waitFor();
  await expectActiveTool("changes");
  await expectSameShell();
  await layout.selectOption("split");
  await splitDiff.waitFor();
  const reviewScrollTop = await review.locator(".workspace-review-scroll").evaluate(async scroller => {
    scroller.scrollTop = 900;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return scroller.scrollTop;
  });
  if (reviewScrollTop < 800) throw new Error("The historical review did not scroll.");
  const expectRetainedReview = async () => {
    await chatPatch.waitFor();
    await expectActiveTool("changes");
    if (await layout.inputValue() !== "split") throw new Error("Reopening Changes reset the review layout.");
    await page.waitForFunction(top =>
      Math.abs(document.querySelector("#review-panel .workspace-review-scroll")?.scrollTop - top) <= 2, reviewScrollTop)
      .catch(async error => { throw new Error(`Review scroll changed: expected ${reviewScrollTop}, received ${await review.locator(".workspace-review-scroll").evaluate(element => element.scrollTop)}.`, { cause: error }); });
  };
  const reviewCode = review.locator('[data-line] span[style]').filter({ hasText: "const" }).first();
  await reviewCode.waitFor();
  const darkSyntax = await reviewCode.evaluate(element => getComputedStyle(element).color);
  await appearance("light");
  await expectRetainedReview();
  await expectColors(page.locator("html"), { "background-color": "rgb(253, 253, 253)", "color": "rgb(23, 23, 23)" });
  await expectColors(page.locator(".titlebar"), { "background-color": "rgb(253, 253, 253)" });
  for (const surface of [nav, page.locator(".titlebar-leading"), tools, review,
    review.locator(".workspace-panel-header"), review.locator(".workspace-review-scroll")]) {
    await expectColors(surface, { "background-color": "rgb(222, 223, 224)" });
  }
  await expectColors(composer, { "background-color": "rgb(245, 245, 245)", "border-top-color": "rgba(0, 0, 0, 0.1)" });
  await expectColors(prompt, { "color": "rgb(23, 23, 23)" });
  await selectedSession.hover();
  await expectColors(selectedSession, { "background-color": "rgb(213, 215, 217)", "color": "rgb(23, 23, 23)" });
  const luminance = color => color.match(/\d+/g).slice(0, 3)
    .map(channel => Number(channel) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const mutedLuminance = luminance(await nav.locator(".nav-header h2").evaluate(element => getComputedStyle(element).color));
  for (const surface of [nav, selectedSession]) {
    const background = luminance(await surface.evaluate(element => getComputedStyle(element).backgroundColor));
    const contrast = (background + 0.05) / (mutedLuminance + 0.05);
    if (!(contrast >= 4.5)) throw new Error(`Light sidebar muted text contrast is below 4.5:1: ${contrast}.`);
  }
  await prompt.hover();
  await expectColors(userMessage.locator(".message-content"), {
    "background-color": "rgb(247, 247, 247)", "color": "rgb(23, 23, 23)", "border-width": "0px",
  });
  await page.waitForFunction(dark => [...document.querySelectorAll('#review-panel diffs-container')]
    .flatMap(container => [...container.shadowRoot.querySelectorAll('[data-line] span[style]')])
    .some(element => element.textContent.includes("const") && getComputedStyle(element).color !== dark), darkSyntax)
    .catch(async error => { throw new Error(`Light diff syntax did not update: ${JSON.stringify(await review.evaluate((element, dark) => ({
      mode: document.documentElement.dataset.colorMode, dark,
      tokens: [...element.querySelectorAll('diffs-container')].flatMap(container => [...container.shadowRoot.querySelectorAll('[data-line] span[style]')])
        .filter(span => span.textContent.includes("const"))
        .slice(0, 3).map(span => ({ color: getComputedStyle(span).color, style: span.getAttribute("style") })),
    }), darkSyntax))}`, { cause: error }); });
  await expectColors(page.locator('.workspace-inline [data-line-type="change-addition"] [data-diff-span]').first(), {
    "background-color": "rgb(172, 238, 187)",
  });
  await expectColors(page.locator('.workspace-inline [data-line-type="change-deletion"] [data-diff-span]').first(), {
    "background-color": "rgb(255, 206, 203)",
  });
  for (const [type, line, gutter] of [["addition", "#dafbe1", "#aceebb"], ["deletion", "#ffebe9", "#ffcecb"]]) {
    await expectPaint(review.locator(`[data-line][data-line-type="change-${type}"]`).first(), line);
    await expectPaint(review.locator(`[data-column-number][data-line-type="change-${type}"]`).first(), gutter);
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-light-workspace.png" });
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await expectSameShell();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#workspace-terminal .xterm-scrollable-element'))
    .backgroundColor === "rgb(222, 223, 224)")
    .catch(async error => { throw new Error(`Light terminal background did not update: ${await terminal.locator('.xterm-scrollable-element').evaluate(element => getComputedStyle(element).backgroundColor)}.`, { cause: error }); });
  for (const surface of [terminal, terminal.locator(".workspace-panel-header"), terminal.locator(".xterm")]) {
    await expectColors(surface, { "background-color": "rgb(222, 223, 224)" });
  }
  const lightViewport = terminal.locator(".xterm-viewport");
  if (await lightViewport.count()) await expectColors(lightViewport, { "background-color": "rgb(222, 223, 224)" });
  const composition = terminal.locator(".composition-view");
  if (await composition.count()) await expectColors(composition, {
    "background-color": "rgb(222, 223, 224)", "color": "rgb(23, 23, 23)",
  });
  await expectTerminalToolbar();
  await page.screenshot({ path: "output/playwright/pideck-ui-light-terminal.png" });
  await appearance("dark");
  await expectSameShell();
  await expectTerminalToolbar();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#workspace-terminal .xterm-scrollable-element'))
    .backgroundColor === "rgb(34, 34, 34)");
  await changes.click();
  await expectRetainedReview();
  await terminalToggle.click();
  await expectActiveTool("terminal");
  await changes.click();
  await expectRetainedReview();
  await changes.click();
  await expectActiveTool();
  await changes.click();
  await expectRetainedReview();
  await layout.selectOption("auto");
  await review.getByRole("heading", { name: "Changes", exact: true }).waitFor();
  await review.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example\.ts/ }).click();
  await chatPatch.waitFor({ state: "detached" });
  await review.getByRole("heading", { name: "example.ts", exact: true }).waitFor();
  await largeDiff.click();
  await chatPatch.waitFor();
  await changes.click();
  await expectActiveTool();
  await largeDiff.click();
  await chatPatch.waitFor();
  await original.click();
  await chatPatch.waitFor({ state: "detached" });
  await forked.click();
  await largeDiff.click();
  const removeOriginal = () => removeFromMenu(original, 'session');
  await page.setViewportSize({ width: 760, height: 560 });
  await sidebar.click();
  await original.press("Backspace");
  await nav.waitFor({ state: "detached" });
  await workspace.getByText("Remove this session’s branches first.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "removal-branches");
  await page.screenshot({ path: "output/playwright/pideck-ui-branches.png" });
  await page.setViewportSize(viewport);
  await workspace.getByRole("button", { name: "Open branch Verify status (fork)", exact: true }).click();
  if (await forked.getAttribute("aria-current") !== "true") throw new Error("The blocking branch did not open.");
  const removeFork = () => removeFromMenu(forked, 'session');
  await removeFork();
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "started");
  if (await forked.getAttribute("aria-current") !== "true" || !await forked.evaluate((button) => button === document.activeElement)) {
    throw new Error("Cancelling removal changed the selected session or keyboard focus.");
  }
  await removeFork();
  await forked.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "released");
  await review.waitFor({ state: "detached" });
  const fallback = draftSession;
  if (await fallback.getAttribute("aria-current") !== "true" || await forked.count()) throw new Error("Session removal did not keep the next session selected.");
  await prompt.fill("Draft to remove with the project.");
  await removeOriginal();
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "started");
  await removeOriginal();
  await page.waitForFunction(() => document.body.dataset.survivingWatch === "attached");
  await original.waitFor({ state: "detached" });
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Reattaching a surviving session lost its draft.");

  await terminalToggle.click();
  await shellRunning.waitFor();
  if (await terminal.getByRole("button", { name: /end shell|stop/i }).count()) throw new Error("The terminal toolbar has a separate stop action.");
  const expectNewShell = async previousId => {
    await page.waitForFunction(id => Boolean(document.body.dataset.terminalId && document.body.dataset.terminalId !== id), previousId);
    await shellRunning.waitFor();
    await expectActiveTool("terminal");
    if (await screen.getAttribute("data-workspace-fixture") !== "same") throw new Error("The new shell replaced the terminal view.");
    return page.evaluate(() => document.body.dataset.terminalId);
  };
  const shellBeforeRestart = await page.evaluate(() => document.body.dataset.terminalId);
  await restartShell.click();
  await page.waitForFunction(id => document.body.dataset.closedTerminalId === id, shellBeforeRestart);
  const restartedShell = await expectNewShell(shellBeforeRestart);
  await screen.focus();
  await page.keyboard.insertText("exit");
  await page.keyboard.press("Enter");
  await terminal.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "toggle-terminal");
  await terminalToggle.click();
  const reopenedShell = await expectNewShell(restartedShell);
  await screen.focus();
  await page.keyboard.insertText("exit 7");
  await page.keyboard.press("Enter");
  await terminal.getByText(/^Shell exited \(7\)/).waitFor();
  await restartShell.click();
  await expectNewShell(reopenedShell);
  const primaryBranch = nav.getByRole("list", { name: "Sample project sessions", exact: true });
  await primaryBranch.getByRole("button", { name: "Separate draft", exact: true }).waitFor();
  if (await fallback.locator(":scope > svg").count()) throw new Error("The session row still displays a leading icon.");
  await nav.getByRole("button", { name: "Collapse Sample project", exact: true }).click();
  await primaryBranch.waitFor({ state: "detached" });
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Collapsing the project changed the active session.");
  await projectRow.press("ArrowRight");
  await primaryBranch.waitFor();
  await projectRow.press("ArrowRight");
  if (!await fallback.evaluate(button => button === document.activeElement)) throw new Error("ArrowRight did not enter the session branch.");
  await fallback.press("ArrowLeft");
  if (!await projectRow.evaluate(button => button === document.activeElement)) throw new Error("ArrowLeft did not return to the project row.");

  await nav.getByRole("button", { name: "Open folder…", exact: true }).click();
  const otherBranch = nav.getByRole("list", { name: "Other project sessions", exact: true });
  const otherTask = otherBranch.getByRole("button", { name: "Other task", exact: true });
  await otherTask.waitFor();
  if (await primaryBranch.getByRole("button", { name: "Other task", exact: true }).count()
    || await otherBranch.getByRole("button", { name: "Separate draft", exact: true }).count()) {
    throw new Error("The tree grouped a session under the wrong project.");
  }
  await primaryBranch.getByRole("button", { name: "Separate draft", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Draft to remove with the project.");
  const otherProjectRow = nav.getByRole("button", { name: "Other project", exact: true });
  const otherNewSession = nav.getByRole("button", { name: "New session in Other project", exact: true });
  await nav.getByRole("button", { name: "Collapse Other project", exact: true }).click();
  await otherBranch.waitFor({ state: "detached" });
  await otherProjectRow.hover();
  await otherNewSession.click();
  await otherTask.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "prompt" && document.activeElement.value === "");
  if (await otherProjectRow.getAttribute("aria-current") !== "true" || await otherTask.getAttribute("aria-current") === "true") {
    throw new Error("The other project's new-session button did not select a draft in that project.");
  }
  await prompt.fill("A draft only in Other project.");
  await fallback.click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Draft to remove with the project.");
  await nav.getByRole("button", { name: "Resume unsent draft in Other project", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "A draft only in Other project.");
  if (await otherBranch.locator(".nav-session-row").count() !== 1) throw new Error("An unsent draft appeared as a session.");
  await fallback.click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Draft to remove with the project.");
  await otherProjectRow.hover();
  await page.screenshot({ path: "output/playwright/pideck-ui-project-tree.png" });
  await otherProjectRow.press("Backspace");
  await otherProjectRow.waitFor({ state: "detached" });
  await otherBranch.waitFor({ state: "detached" });
  if (await fallback.getAttribute("aria-current") !== "true") throw new Error("Removing a sibling project changed the selected session.");
  const removeProject = () => removeFromMenu(projectRow, 'project');
  const previousPreferences = await page.evaluate(() => localStorage.getItem("pideck.workspace.v1"));
  await removeProject();
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Cancelling project removal discarded a draft.");
  await removeProject();
  await workspace.getByRole("heading", { name: "Open a project folder" }).waitFor();
  await page.getByRole("region", { name: "Project terminal" }).waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    return !preferences.projectId && Object.keys(preferences.sessions ?? {}).length === 0
      && Object.keys(preferences.reading ?? {}).length === 0 && Object.keys(preferences.reviewPaths ?? {}).length === 0
      && !Object.keys(localStorage).some(key => key.startsWith("pideck.draft.v1/"));
  });
  await page.evaluate((previous) => localStorage.setItem("pideck.workspace.v1", previous), previousPreferences);
  await page.reload();
  await workspace.getByRole("heading", { name: "Open a project folder" }).waitFor();
  await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    return !preferences.projectId && Object.keys(preferences.sessions ?? {}).length === 0;
  });
  if (errors.length) throw new Error(errors.join("\n"));
  return "Renderer flow passed.";
}
