async page => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8_000);
  const workspace = page.getByRole("region", { name: "Workspace" });
  const nav = page.getByRole("complementary", { name: "Workspace navigation" });
  const prompt = page.getByRole("textbox", { name: "Message Pideck" });
  const canvas = "rgb(13, 17, 23)";
  const overlay = "rgb(1, 4, 9)";
  const foreground = "rgb(240, 246, 252)";
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

  const open = page.getByRole("button", { name: /^Open (?:a project )?folder$/i });
  await open.waitFor();
  if (await open.count() !== 1 || await nav.count()) throw new Error("Welcome has duplicate workspace navigation.");
  await expectColors(page.locator("html"), {
    "--bgColor-default": "#0d1117",
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
  await provider.locator('option[value="openai"]').waitFor({ state: "attached" });
  await expectColors(settings, { "background-color": overlay, "border-top-color": "rgba(61, 68, 77, 0.7)", "color": foreground });
  await expectColors(settings, { "background-color": "rgba(33, 40, 48, 0.4)" }, "::backdrop");
  await expectColors(provider, { "background-color": canvas, "border-top-color": "rgb(61, 68, 77)", "color": foreground });
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
  await settings.getByRole("button", { name: "Use API key", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-providers.png" });
  await settings.getByRole("button", { name: "Sign in with browser" }).click();
  await settings.getByText("PIDE-CK99").waitFor();
  await settings.getByRole("button", { name: /Open fixture.invalid/ }).click();
  await settings.getByRole("button", { name: "Copy code" }).click();
  const authorization = settings.getByLabel("Authorization code");
  const continueSignIn = settings.getByRole("button", { name: "Continue" });
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
  const alignedConnection = await connection.evaluate(card => {
    const middle = element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    const status = middle(card.querySelector(".key-status"));
    const actions = [...card.querySelectorAll(".provider-connection-header button")];
    return actions.length === 3 && actions.every(action => Math.abs(middle(action) - status) < 1);
  });
  if (!alignedConnection) throw new Error("The connected status and actions do not align.");
  await connection.getByRole("button", { name: "Refresh models", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-providers-connected.png" });
  await connection.getByRole("button", { name: "Disconnect…", exact: true }).click();
  await connection.getByText("Disconnect Fixture provider from Pideck?", { exact: true }).waitFor();
  await connection.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.getByRole("button", { name: "Close settings" }).click();

  await prompt.fill("Update and verify the status.");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Update and verify the status.");
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
  await expectColors(composer, { "background-color": canvas });
  await expectColors(prompt, { "color": foreground });
  await model.press("ArrowDown");
  await page.waitForFunction(() => document.body.dataset.savedModelCatalog === "available");
  await model.getByText("Off", { exact: true }).waitFor();
  await expectColors(picker, { "background-color": overlay, "color": foreground });
  await expectColors(modelSearch, { "background-color": canvas });
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
    "background-color": "rgba(101, 108, 118, 0.2)",
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
      && getComputedStyle(button).opacity === "0")) {
    throw new Error("The new-session action is not tucked into the project row.");
  }
  await projectRow.hover();
  if (await newSession.evaluate(button => getComputedStyle(button).opacity) !== "1") {
    throw new Error("Hovering over the project did not reveal the new-session button.");
  }
  await newSession.click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  if (await sessionCount() !== 1 || await prompt.inputValue() !== "") throw new Error("New session did not open a blank draft.");
  await runningSession.click();
  if (await sessionCount() !== 1) throw new Error("Leaving a blank draft left an empty session.");
  await prompt.hover();
  await projectRow.press("Tab");
  if (!await newSession.evaluate(button => button === document.activeElement && getComputedStyle(button).opacity === "1")) {
    throw new Error("Tab did not reach and reveal the project's new-session button.");
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
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-second-run")));
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
  await queueEditButton.press("Enter");
  const queueEdit = page.getByRole("textbox", { name: "Edit queued message" });
  await queueEdit.waitFor();
  if (await queueEdit.inputValue() !== editableText || !await queueEdit.evaluate(editor => editor === document.activeElement)) {
    throw new Error("The inline queue editor did not load and focus the full message.");
  }
  await queueEdit.press("Escape");
  await queueEditButton.waitFor();
  if (!await queueEditButton.evaluate(button => button === document.activeElement)) {
    throw new Error("Closing the inline queue editor lost keyboard focus.");
  }

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
  await queueEditButton.click();
  await queueEdit.fill("Report the final verification.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await row("Report the final verification.").waitFor();
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
  await successfulCommand.press("Enter");
  await page.getByText("Running the status check…", { exact: true }).waitFor({ state: "hidden" });
  await successfulCommand.press("Enter");
  await page.getByText("Running the status check…", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-write-result")));
  await page.getByRole("status").getByText("Writing response…", { exact: true }).waitFor();
  await page.locator(".tool-output").filter({ hasText: "Verified step 8." }).waitFor();
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
  await draftSession.click();
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-queue")));
  const finishedBadge = runningSession.locator("[data-activity=finished]");
  await finishedBadge.locator("svg.lucide-check").waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-background.png" });
  await runningSession.click();
  await page.getByText("I updated the status and checked the result.").waitFor({ state: "attached" });
  const latest = page.getByRole("button", { name: "Latest", exact: true });
  await latest.waitFor();
  if (!await finishedBadge.count()) throw new Error("Opening at an old reading position cleared the unseen result.");
  await latest.click();
  await finishedBadge.waitFor({ state: "detached" });
  await page.setViewportSize(queueViewport);
  const successOutput = page.getByText("Checks passed.", { exact: true });
  await successfulCommand.getByText("Succeeded", { exact: true }).waitFor();
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
  await userMessage.hover();
  const userBranch = userMessage.getByRole("button", { name: "Branch from here" });
  await userBranch.hover();
  if (await userBranch.evaluate(button => getComputedStyle(button).opacity) !== "1") {
    throw new Error("The user message branch action did not stay visible on hover.");
  }
  const branchMessage = assistantMessage.getByRole("button", { name: "Branch from here" });
  await page.mouse.move(0, 0);
  if (!await branchMessage.evaluate(button => getComputedStyle(button).opacity === "0" && !button.textContent.trim() && Boolean(button.querySelector("svg")))) {
    throw new Error("The message branch action should be a hidden icon until hover or focus.");
  }
  await branchMessage.focus();
  if (await branchMessage.evaluate(button => getComputedStyle(button).opacity) !== "1") {
    throw new Error("Keyboard focus did not reveal the message branch action.");
  }
  await branchMessage.press("Enter");
  const forked = nav.getByRole("button", { name: "Verify status (fork)", exact: true });
  const original = nav.getByRole("button", { name: "Verify status", exact: true });
  await forked.waitFor();
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
    "background-color": "rgba(101, 108, 118, 0.2)",
    "color": foreground,
    "border-top-color": "rgba(0, 0, 0, 0)",
  };
  const terminal = page.getByRole("region", { name: "Project terminal" });
  const findTerminal = terminal.getByRole("button", { name: "Find in terminal", exact: true });
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
  const expectRestartBesideFind = async () => {
    const [find, restart] = await Promise.all([findTerminal.boundingBox(), restartShell.boundingBox()]);
    if (!find || !restart || restart.x < find.x + find.width || Math.abs(restart.y - find.y) > 1
      || !await restartShell.evaluate(button => !button.textContent.trim() && Boolean(button.title && button.querySelector("svg")))) {
      throw new Error("The terminal restart icon must sit to the right of Find in terminal and have a tooltip.");
    }
  };
  const review = page.getByRole("complementary", { name: "Review changes" });
  const expectToolbarEdge = async () => {
    const aligned = await page.evaluate(() => {
      const header = document.querySelector(".titlebar-content");
      const dockedTools = document.querySelector("#workspace-tools[data-docked]");
      const middleEdge = dockedTools?.getBoundingClientRect().left ?? window.innerWidth;
      const inset = parseFloat(getComputedStyle(header).paddingInlineEnd);
      const changes = document.getElementById("toggle-review").getBoundingClientRect();
      const terminal = document.getElementById("toggle-terminal").getBoundingClientRect();
      return Math.abs(header.getBoundingClientRect().right - middleEdge) <= 1
        && changes.right <= terminal.left && Math.abs(terminal.right - (middleEdge - inset)) <= 1;
    });
    if (!aligned) throw new Error("The workspace toggles do not align to the visible middle column's right edge.");
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
      const reviewToggle = bounds("#toggle-review");
      const panel = bounds(pane);
      const panelHeader = bounds(pane + " .workspace-panel-header");
      return sameEdge(bounds(".titlebar-leading").right, sidebarEdge)
        && sameEdge(centerX("#toggle-navigation"), centerX("#nav-open-project"))
        && sameEdge(conversation.left, sidebarEdge)
        && sameEdge(conversation.right, right.left)
        && sameEdge(bounds(".chat-thread").left, bounds(".composer").left)
        && sameEdge(middleHeader.left, sidebarEdge)
        && sameEdge(middleHeader.right, right.left)
        && sessionTitle.left - middleHeader.left <= 24 && sessionTitle.left > middleHeader.left
        && sessionTitle.right <= reviewToggle.left
        && sameEdge(panel.top, titlebar.top) && sameEdge(panelHeader.bottom, titlebar.bottom)
        && sameEdge(panel.left, right.left) && sameEdge(panel.right, right.right)
        && sameEdge(panel.bottom, right.bottom);
    }, pane);
    if (!aligned) throw new Error("The active tool must fill the right sidebar beside the middle header.");
  };
  await expectActiveTool("changes");
  await expectDockedTool("#review-panel");
  const dockedTogglePositions = await togglePositions();
  if (await tools.locator("[role=separator]").count()) throw new Error("The right sidebar still splits tools vertically.");
  for (const surface of [page.locator(".titlebar"), nav, review]) await expectColors(surface, { "background-color": canvas });
  await expectColors(nav.locator('.nav-session-row[aria-current="true"]'), { "background-color": "rgb(33, 40, 48)" });
  await expectColors(sidebar, selectedToggleColors);
  await expectColors(changes, selectedToggleColors);
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
  await expectRestartBesideFind();
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
  await expectRestartBesideFind();
  await screen.waitFor();
  const terminalBack = terminal.getByRole("button", { name: "Back to chat" });
  await terminalBack.waitFor();
  if ((await terminal.boundingBox()).width < 755 || await tools.getAttribute("data-docked") !== null) {
    throw new Error("The compact terminal does not use the full workspace.");
  }
  await expectColors(terminal.locator(".workspace-panel-header"), { "background-color": canvas });
  await expectColors(terminal.locator(".xterm-scrollable-element"), { "background-color": "rgb(1, 4, 9)" });
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
      Math.abs(document.querySelector("#review-panel .workspace-review-scroll")?.scrollTop - top) <= 2, reviewScrollTop);
  };
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
  const removeOriginal = nav.getByRole("button", { name: "Remove session Verify status", exact: true });
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
  const removeFork = nav.getByRole("button", { name: "Remove session Verify status (fork)", exact: true });
  await removeFork.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "started");
  if (await forked.getAttribute("aria-current") !== "true" || !await removeFork.evaluate((button) => button === document.activeElement)) {
    throw new Error("Cancelling removal changed the selected session or keyboard focus.");
  }
  await removeFork.click();
  await forked.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "released");
  await review.waitFor({ state: "detached" });
  const fallback = draftSession;
  if (await fallback.getAttribute("aria-current") !== "true" || await forked.count()) throw new Error("Session removal did not keep the next session selected.");
  await prompt.fill("Draft to remove with the project.");
  await removeOriginal.click();
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "started");
  await removeOriginal.click();
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
  const removeProject = nav.getByRole("button", { name: "Remove project Sample project", exact: true });
  const previousPreferences = await page.evaluate(() => localStorage.getItem("pideck.workspace.v1"));
  await removeProject.click();
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Cancelling project removal discarded a draft.");
  await removeProject.click();
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
