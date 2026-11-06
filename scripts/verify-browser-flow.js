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
  await workspace.getByRole("button", { name: "Trust project" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "workspace-new-session");
  if (await page.getByRole("button", { name: "New session", exact: true }).count() !== 1) {
    throw new Error("First session has duplicate entry points.");
  }
  await workspace.getByRole("button", { name: "New session", exact: true }).click();
  await prompt.waitFor();
  const connect = page.getByRole("button", { name: "Connect a provider", exact: true });
  if (await connect.count() !== 1) throw new Error("The composer has duplicate provider setup actions.");
  await connect.click();
  const settings = page.getByRole("dialog", { name: "Model providers" });
  const provider = settings.getByRole("combobox", { name: "Provider", exact: true });
  await provider.locator('option[value="openai"]').waitFor({ state: "attached" });
  if (await provider.inputValue() !== "") throw new Error("Provider setup chose an account without user input.");
  await provider.selectOption("openai");
  await settings.getByLabel("Sign-in method").selectOption("oauth");
  await settings.getByRole("button", { name: "Sign in with browser" }).click();
  await settings.getByText("PIDE-CK99").waitFor();
  await settings.getByRole("button", { name: /Open fixture.invalid/ }).click();
  await settings.getByRole("button", { name: "Copy code" }).click();
  await settings.getByLabel("Authorization code").fill("test-authorization");
  await settings.getByRole("button", { name: "Continue" }).click();
  await settings.getByText("Fixture provider connected.").waitFor();
  await settings.getByRole("button", { name: "Close settings" }).click();

  await prompt.fill("Update and verify the status.");
  await nav.getByRole("button", { name: "New session", exact: true }).click();
  await nav.getByRole("button", { name: "Session 2", exact: true }).waitFor();
  await prompt.fill("A separate draft.");
  await nav.getByRole("button", { name: "Session 2", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  if (await prompt.inputValue() !== "Update and verify the status.") throw new Error("Draft did not survive a session switch.");

  await page.getByRole("button", { name: "Model", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.getByRole("searchbox", { name: "Search models" }).fill("fixture");
  await picker.getByRole("button", { name: /Fixture model/ }).click();
  await page.getByLabel("Thinking level").selectOption("high");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Pideck is working").waitFor();
  if (await prompt.inputValue() !== "") throw new Error("Accepted draft was not reconciled on reconnect.");
  await page.getByLabel("Message delivery").selectOption("steer");
  await prompt.fill("Prefer a focused check.");
  await page.getByRole("button", { name: "Steer the run" }).click();
  await page.getByText("Prefer a focused check.", { exact: true }).waitFor();
  await prompt.fill("Report the verification.");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await page.getByText("I updated the status and checked the result.").waitFor();
  await page.getByText("Checks passed.").waitFor();

  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await page.getByText("An earlier coding request.").waitFor();
  await page.getByLabel("Session actions").click();
  await page.getByRole("button", { name: "Compact context…" }).click();
  const compact = page.getByRole("dialog", { name: "Compact context" });
  await compact.getByLabel(/What should the summary preserve/).fill("Keep the testing details.");
  await compact.getByRole("button", { name: "Compact context" }).click();
  await page.getByText("Context compacted.").waitFor();
  await page.getByLabel("Session actions").click();
  await page.getByRole("button", { name: "Fork from latest turn" }).click();
  const forked = nav.getByRole("button", { name: "Session 1 (fork)", exact: true });
  const original = nav.getByRole("button", { name: "Session 1", exact: true });
  await forked.waitFor();
  await original.click();
  await page.reload();
  await page.getByText("I updated the status and checked the result.").waitFor();
  if (await original.getAttribute("aria-current") !== "true") throw new Error("Session selection did not survive reload.");
  await forked.click();

  await page.getByRole("button", { name: "Toggle review" }).click();
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example.ts/ }).click();
  const split = page.getByRole("button", { name: "Split", exact: true });
  await split.click();
  if (await split.getAttribute("aria-pressed") !== "true") throw new Error("Split layout did not activate.");
  await page.getByRole("complementary", { name: "Review changes" }).locator("diffs-container").filter({ hasText: "verified" }).last().waitFor();
  const review = page.getByRole("complementary", { name: "Review changes" });
  const viewport = page.viewportSize();
  const aligned = await page.evaluate(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    return Math.abs(bounds(".titlebar-leading").right - bounds(".navigation").right) <= 1
      && Math.abs(bounds(".chat-thread").left - bounds(".composer").left) <= 1;
  });
  if (!aligned) throw new Error("The titlebar and sidebar, or the transcript and composer, do not align.");
  await page.screenshot({ path: "output/playwright/pideck-ui-workspace.png" });
  await page.setViewportSize({ width: 760, height: 560 });
  await page.waitForFunction(() => document.querySelector(".workspace-conversation").inert
    && document.querySelector("#review-panel").contains(document.activeElement));
  await page.screenshot({ path: "output/playwright/pideck-ui-narrow.png" });
  await page.keyboard.press("Escape");
  await review.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.querySelector(".workspace-conversation").inert
    && document.activeElement?.id === "toggle-review");
  await page.setViewportSize(viewport);
  await page.getByRole("button", { name: "Open review", exact: true }).click();
  await review.getByTitle("Assistant patch for example.ts").waitFor();
  await original.click();
  await review.getByTitle("Assistant patch for example.ts").waitFor({ state: "detached" });
  await forked.click();
  await page.getByRole("button", { name: "Open review", exact: true }).click();
  const removeOriginal = nav.getByRole("button", { name: "Remove session Session 1", exact: true });
  await original.focus();
  await page.keyboard.press("Backspace");
  await workspace.getByText("Remove this session’s branches first.", { exact: true }).waitFor();
  const removeFork = nav.getByRole("button", { name: "Remove session Session 1 (fork)", exact: true });
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
  const fallback = nav.getByRole("button", { name: "Session 2", exact: true });
  if (await fallback.getAttribute("aria-current") !== "true" || await forked.count()) throw new Error("Session removal did not keep the next session selected.");
  await prompt.fill("Draft to remove with the project.");
  await removeOriginal.click();
  await page.waitForFunction(() => document.body.dataset.staleSessionList === "started");
  await removeOriginal.click();
  await page.waitForFunction(() => document.body.dataset.survivingWatch === "attached");
  await original.waitFor({ state: "detached" });
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Reattaching a surviving session lost its draft.");

  await page.getByRole("button", { name: "Toggle terminal" }).click();
  await page.getByText("Shell running").waitFor();
  const removeProject = nav.getByRole("button", { name: "Remove project Sample project", exact: true });
  const previousPreferences = await page.evaluate(() => localStorage.getItem("pideck.workspace.v1"));
  await removeProject.click();
  if (await prompt.inputValue() !== "Draft to remove with the project.") throw new Error("Cancelling project removal discarded a draft.");
  await removeProject.click();
  await workspace.getByRole("heading", { name: "Open a project folder" }).waitFor();
  await page.getByRole("region", { name: "Project terminal" }).waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const preferences = JSON.parse(localStorage.getItem("pideck.workspace.v1") ?? "{}");
    return !preferences.projectId && Object.keys(preferences.sessions ?? {}).length === 0;
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
