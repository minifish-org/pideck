async page => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8_000);
  const workspace = page.getByRole("region", { name: "Workspace" });
  const nav = page.getByRole("complementary", { name: "Workspace navigation" });
  const prompt = page.getByRole("textbox", { name: "Message Pideck" });

  const open = page.getByRole("button", { name: /^Open (?:a project )?folder$/i });
  await open.waitFor();
  if (await open.count() !== 1 || await nav.count()) throw new Error("Welcome has duplicate workspace navigation.");
  await page.screenshot({ path: "output/playwright/pideck-ui-welcome.png" });
  await open.click();
  await page.waitForFunction(() => document.activeElement?.id === "workspace-trust");
  await workspace.getByRole("button", { name: "Review permissions" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  const sessionCount = () => page.evaluate(async () => {
    const [project] = await window.pideck.invoke("project:list");
    return (await window.pideck.invoke("session:list", { projectId: project.id })).length;
  });
  if (await sessionCount() !== 0) throw new Error("Trust created a blank session.");
  await page.screenshot({ path: "output/playwright/pideck-ui-first-draft.png" });
  const connect = page.getByRole("button", { name: "Connect a provider", exact: true });
  if (await connect.count() !== 1) throw new Error("The composer has duplicate provider setup actions.");
  await connect.click();
  const settings = page.getByRole("dialog", { name: "Model providers" });
  const provider = settings.getByRole("combobox", { name: "Provider", exact: true });
  await provider.locator('option[value="openai"]').waitFor({ state: "attached" });
  if (await provider.inputValue() !== "") throw new Error("Provider setup chose an account without user input.");
  await provider.selectOption("openai");
  if (await settings.getByRole("combobox", { name: "Sign-in method" }).count()) throw new Error("Connection methods repeat an extra selection step.");
  await settings.getByRole("button", { name: "Use API key", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-providers.png" });
  await settings.getByRole("button", { name: "Sign in with browser" }).click();
  await settings.getByText("PIDE-CK99").waitFor();
  await settings.getByRole("button", { name: /Open fixture.invalid/ }).click();
  await settings.getByRole("button", { name: "Copy code" }).click();
  await settings.getByLabel("Authorization code").fill("test-authorization");
  await settings.getByRole("button", { name: "Continue" }).click();
  await settings.getByText("Fixture provider connected.").waitFor();
  await settings.getByRole("button", { name: "Close settings" }).click();

  await prompt.fill("Update and verify the status.");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Update and verify the status.");
  if (await sessionCount() !== 0) throw new Error("Writing an unsent draft created a session.");

  const model = page.getByRole("button", { name: "Model", exact: true });
  const picker = page.getByRole("region", { name: "Choose a model" });
  await model.press("ArrowDown");
  const modelSearch = picker.getByRole("searchbox", { name: "Search models" });
  await modelSearch.fill("fixture");
  await modelSearch.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.classList.contains("model-option"));
  await page.keyboard.press("Enter");
  await picker.waitFor({ state: "hidden" });
  await model.click();
  await picker.getByRole("combobox", { name: "Thinking level" }).selectOption("high");
  await page.screenshot({ path: "output/playwright/pideck-ui-model-menu.png" });
  await picker.getByRole("combobox", { name: "Thinking level" }).press("Escape");
  await picker.waitFor({ state: "hidden" });
  if (!await model.evaluate(button => button === document.activeElement)) throw new Error("Dismissing the model menu did not restore focus.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Pideck is working").waitFor();
  const runningSessionId = await nav.locator(".nav-scroll [aria-current=true]").getAttribute("id");
  const runningSession = nav.locator(`#${runningSessionId}`);
  await runningSession.locator("[data-activity=running]").waitFor();
  if (await prompt.inputValue() !== "") throw new Error("Accepted draft was not reconciled on reconnect.");
  if (await sessionCount() !== 1) throw new Error("The first send did not create exactly one session.");
  await page.getByText("Running the status check…", { exact: true }).waitFor();

  const newSession = nav.getByRole("button", { name: "New session", exact: true });
  await newSession.click();
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  if (await sessionCount() !== 1 || await prompt.inputValue() !== "") throw new Error("New session did not open a blank draft.");
  await runningSession.click();
  if (await sessionCount() !== 1) throw new Error("Leaving a blank draft left an empty session.");
  await newSession.click();
  await prompt.fill("Start a separate session.");
  await runningSession.click();
  await newSession.click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Start a separate session.");
  if (await sessionCount() !== 1) throw new Error("Switching away from a draft created a session.");
  await prompt.press("Enter");
  await runningSession.click();
  await page.evaluate(() => window.dispatchEvent(new Event("pideck-fixture-finish-start")));
  const startedSession = nav.getByRole("button", { name: "Start a separate session.", exact: true });
  await startedSession.waitFor();
  if (await runningSession.getAttribute("aria-current") !== "true") throw new Error("A late first-send reply changed the active session.");
  await startedSession.click();
  const currentRow = nav.locator(".nav-scroll .nav-row[aria-current=true]");
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
  for (const text of ["Prefer a focused check.", "Report the verification.", "Drop this duplicate.", "List follow-up work."]) {
    await prompt.fill(text);
    await prompt.press("Enter");
    await row(text).waitFor();
  }
  if (await queue.getByRole("button", { name: "Queued message actions", exact: true }).count()) {
    throw new Error("The queue still requires opening an actions menu.");
  }
  if (await queueButton("Prefer a focused check.", "Move up").isEnabled()
    || await queueButton("List follow-up work.", "Move down").isEnabled()) {
    throw new Error("A queued message can move past the end of its group.");
  }
  await page.screenshot({ path: "output/playwright/pideck-ui-running.png" });
  const queueViewport = page.viewportSize();
  await page.setViewportSize({ width: 760, height: 560 });
  const editableText = "Report the verification.";
  const narrowActions = queueActions(editableText);
  await narrowActions.scrollIntoViewIfNeeded();
  for (const name of ["Steer current run", "Edit message", "Move up", "Move down", "Delete message"]) {
    await queueButton(editableText, name).waitFor();
  }
  const inlineButtonsFit = await narrowActions.evaluate(group => {
    const preview = group.closest("li")?.querySelector(".queued-preview")?.getBoundingClientRect();
    const list = group.closest("ol")?.getBoundingClientRect();
    const buttons = [...group.querySelectorAll("button")].map(button => button.getBoundingClientRect());
    return preview && list && preview.width >= 40 && buttons.length === 5 && buttons.every((bounds, index) =>
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
  await page.setViewportSize(queueViewport);
  await queueEditButton.click();
  await queueEdit.fill("Report the final verification.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await row("Report the final verification.").waitFor();
  const moveDown = queueButton("Report the final verification.", "Move down");
  await moveDown.press("Enter");
  await queue.getByRole("listitem").nth(2).getByText("Report the final verification.", { exact: true }).waitFor();
  if (!await moveDown.evaluate(button => button === document.activeElement)) throw new Error("Reordering lost the active button.");
  await queueButton("Drop this duplicate.", "Delete message").press("Enter");
  await row("Drop this duplicate.").waitFor({ state: "detached" });
  if (!await queueButton("Report the final verification.", "Edit message").evaluate(button => button === document.activeElement)) {
    throw new Error("Deleting a queued message lost keyboard focus.");
  }
  await queueButton("List follow-up work.", "Move up").click();
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
  await nav.locator(`.nav-scroll .nav-row:not([id="${runningSessionId}"])`).first().click();
  const finishedBadge = runningSession.locator("[data-activity=finished]");
  await finishedBadge.waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-background.png" });
  await runningSession.click();
  await finishedBadge.waitFor({ state: "detached" });
  await page.getByText("I updated the status and checked the result.").waitFor();
  const successfulCommand = page.locator(".tool-card summary").filter({ hasText: "npm test" });
  const successOutput = page.getByText("Checks passed.", { exact: true });
  await successfulCommand.getByText("Succeeded", { exact: true }).waitFor();
  await successOutput.waitFor({ state: "hidden" });
  await page.getByText("Lint reported an error.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open review", exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-tool-logs.png" });
  await successfulCommand.press("Enter");
  await successOutput.waitFor();
  await successfulCommand.press("Enter");
  await successOutput.waitFor({ state: "hidden" });
  await nav.getByRole("button", { name: "Update and verify the status.", exact: true }).waitFor();
  await page.getByRole("button", { name: "Rename session Update and verify the status.", exact: true }).click();
  await sessionName.fill("Verify status");
  await sessionName.press("Enter");

  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await page.getByText("An earlier coding request.").waitFor();
  if (await page.getByRole("button", { name: "Summarize context" }).count()) {
    throw new Error("The title bar still exposes manual context compaction.");
  }
  await page.getByRole("article", { name: "Pideck" }).filter({ hasText: "I updated the status and checked the result." })
    .getByRole("button", { name: "Branch from here" }).click();
  const forked = nav.getByRole("button", { name: "Verify status (fork)", exact: true });
  const original = nav.getByRole("button", { name: "Verify status", exact: true });
  await forked.waitFor();
  await original.click();
  await page.getByText("An earlier coding request.").waitFor();
  const resumeViewport = page.viewportSize();
  await page.setViewportSize({ width: resumeViewport.width, height: 340 });
  await page.locator(".chat-scroll").evaluate(scroll => { scroll.scrollTop = 18; });
  const position = await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    const id = preferences.sessions?.[preferences.projectId];
    return preferences.reading?.[preferences.projectId]?.[id];
  }).then(handle => handle.jsonValue());
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
  await page.getByRole("complementary", { name: "Review changes" }).getByRole("heading", { name: "second.ts", exact: true }).waitFor();
  await changeButton.click();
  await page.evaluate(() => sessionStorage.removeItem("pideck-extra-review-file"));
  await forked.click();
  await page.screenshot({ path: "output/playwright/pideck-ui-conversation.png" });

  const changes = page.getByRole("button", { name: "Changes", exact: true });
  const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
  const terminal = page.getByRole("region", { name: "Project terminal" });
  await page.evaluate(() => sessionStorage.setItem("pideck-review-list-failure", "1"));
  await changes.click();
  const review = page.getByRole("complementary", { name: "Review changes" });
  const retry = review.getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  await page.evaluate(() => sessionStorage.removeItem("pideck-review-list-failure"));
  await retry.click();
  const layout = review.getByRole("combobox", { name: "Diff layout" });
  const singleDiff = review.locator("diffs-container [data-diff-type=single]").first();
  const splitDiff = review.locator("diffs-container [data-diff-type=split]").first();
  await singleDiff.waitFor();
  await review.getByRole("button", { name: /Refresh/i }).waitFor({ state: "hidden" });
  await page.evaluate(() => {
    sessionStorage.setItem("pideck-review-patch-failure", "1");
    window.dispatchEvent(new Event("pideck-fixture-review-change"));
  });
  await retry.waitFor();
  await page.evaluate(() => sessionStorage.removeItem("pideck-review-patch-failure"));
  await retry.click();
  await retry.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    sessionStorage.setItem("pideck-review-edit", "1");
    window.dispatchEvent(new Event("pideck-fixture-review-change"));
  });
  await singleDiff.getByText("updated", { exact: false }).waitFor();
  await page.evaluate(() => sessionStorage.removeItem("pideck-review-edit"));
  const divider = page.getByRole("separator", { name: "Resize review" });
  const reviewWidthBefore = (await review.boundingBox()).width;
  await divider.press("Shift+ArrowLeft");
  await page.waitForFunction(width => document.getElementById("review-panel").getBoundingClientRect().width > width + 20, reviewWidthBefore);
  await divider.press("Enter");
  await page.waitForFunction(width => Math.abs(document.getElementById("review-panel").getBoundingClientRect().width - width) < 2, reviewWidthBefore);
  if (await layout.inputValue() !== "auto") throw new Error("Diff layout does not start in Auto.");
  await layout.selectOption("split");
  await splitDiff.waitFor();
  await layout.selectOption("auto");
  await singleDiff.waitFor();
  if (await review.getByRole("button", { name: "Back to chat" }).count()) throw new Error("Wide review has a duplicate close action.");
  const viewport = page.viewportSize();
  const aligned = await page.evaluate(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    return Math.abs(bounds(".titlebar-leading").right - bounds(".navigation").right) <= 1
      && Math.abs(bounds(".chat-thread").left - bounds(".composer").left) <= 1;
  });
  if (!aligned) throw new Error("The titlebar and sidebar, or the transcript and composer, do not align.");
  await page.screenshot({ path: "output/playwright/pideck-ui-workspace.png" });
  await page.setViewportSize({ width: 1920, height: 960 });
  await splitDiff.waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-wide.png" });
  await page.setViewportSize({ width: 1100, height: 680 });
  const back = review.getByRole("button", { name: "Back to chat" });
  await back.waitFor();
  const sidebar = page.locator("#toggle-navigation");
  await sidebar.click();
  await back.waitFor({ state: "detached" });
  await sidebar.click();
  await back.waitFor();
  await page.setViewportSize({ width: 760, height: 560 });
  await page.waitForFunction(() => document.querySelector(".workspace-conversation").inert
    && document.querySelector("#review-panel").contains(document.activeElement));
  await back.waitFor();
  await nav.waitFor({ state: "detached" });
  await changes.waitFor({ state: "hidden" });
  const reviewWidth = await review.evaluate(panel => panel.getBoundingClientRect().width);
  if (reviewWidth < 755) throw new Error("The compact review does not use the full window.");
  await page.screenshot({ path: "output/playwright/pideck-ui-narrow.png" });
  await back.click();
  await review.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.querySelector(".workspace-conversation").inert
    && document.activeElement?.id === "toggle-review");
  await model.click();
  await modelSearch.waitFor();
  const compactMenuFits = await picker.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    return bounds.top >= 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  });
  if (!compactMenuFits) throw new Error("The model dropdown overflows a narrow window.");
  await page.locator(".titlebar").click({ position: { x: 380, y: 25 } });
  await picker.waitFor({ state: "hidden" });
  await sidebar.click();
  await nav.waitFor();
  await page.waitForFunction(() => document.querySelector(".workspace").inert
    && document.activeElement?.id.startsWith("nav-session-"));
  if (await page.locator(".workspace").evaluate(panel => panel.getBoundingClientRect().width) !== 760) throw new Error("Compact sidebar squeezed the workspace.");
  await page.screenshot({ path: "output/playwright/pideck-ui-sidebar.png" });
  await page.keyboard.press("Escape");
  await nav.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.id === "toggle-navigation");
  await sidebar.click();
  await nav.waitFor();
  await terminalToggle.click();
  await nav.waitFor({ state: "detached" });
  await terminal.getByText("Shell running").waitFor();
  const screen = terminal.locator(".xterm-helper-textarea");
  await screen.waitFor();
  await screen.evaluate(element => { element.dataset.workspaceFixture = "same"; });
  await changes.click();
  await terminal.waitFor({ state: "hidden" });
  await terminalToggle.click();
  await terminal.waitFor();
  await review.waitFor({ state: "detached" });
  if (await screen.getAttribute("data-workspace-fixture") !== "same") throw new Error("Returning from review replaced the live terminal.");
  await page.screenshot({ path: "output/playwright/pideck-ui-terminal.png" });
  await terminalToggle.click();
  await page.setViewportSize(viewport);
  await page.getByRole("button", { name: "Open review", exact: true }).click();
  await review.getByTitle("Assistant patch for example.ts").waitFor();
  await review.getByRole("button", { name: "Project changes", exact: true }).click();
  await review.getByTitle("Assistant patch for example.ts").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Open review", exact: true }).click();
  await review.getByTitle("Assistant patch for example.ts").waitFor();
  await original.click();
  await review.getByTitle("Assistant patch for example.ts").waitFor({ state: "detached" });
  await forked.click();
  await page.getByRole("button", { name: "Open review", exact: true }).click();
  const removeOriginal = nav.getByRole("button", { name: "Remove session Verify status", exact: true });
  await original.focus();
  await page.keyboard.press("Backspace");
  await workspace.getByText("Remove this session’s branches first.", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/pideck-ui-branches.png" });
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

  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByText("Shell running").waitFor();
  await page.getByRole("button", { name: "End shell", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Shell running").waitFor();
  const projectPicker = nav.getByRole("button", { name: /Switch project, current project/ });
  if (await nav.getByRole("group", { name: "Saved projects" }).count()) throw new Error("The project list obscures sessions by default.");
  const sessionTop = (await fallback.boundingBox()).y;
  await projectPicker.press("ArrowDown");
  await page.getByRole("group", { name: "Saved projects" }).waitFor();
  if (Math.abs((await fallback.boundingBox()).y - sessionTop) > 1) throw new Error("The project menu moves the sessions beneath it.");
  await page.waitForFunction(() => document.activeElement?.id.startsWith("nav-project-")
    && document.activeElement?.id !== "nav-project-picker");
  await nav.getByRole("button", { name: "Sample project", exact: true }).press("Escape");
  if (await projectPicker.getAttribute("aria-expanded") !== "false" || !await projectPicker.evaluate(button => button === document.activeElement)) {
    throw new Error("Dismissing project selection did not return keyboard focus.");
  }
  await projectPicker.click();
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
