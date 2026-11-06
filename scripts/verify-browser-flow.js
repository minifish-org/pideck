async page => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8_000);
  const workspace = page.getByRole("region", { name: "Workspace" });
  const nav = page.getByRole("complementary", { name: "Workspace navigation" });
  const prompt = page.getByRole("textbox", { name: "Message Pideck" });

  await workspace.getByRole("button", { name: /Open folder/ }).click();
  await workspace.getByRole("button", { name: "Trust project" }).click();
  await workspace.getByRole("button", { name: /New session/ }).click();
  await prompt.waitFor();
  await page.getByRole("button", { name: "Connect a provider", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Model providers" });
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
  await nav.getByRole("button", { name: /Session 1/ }).click();
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
  if (errors.length) throw new Error(errors.join("\n"));
  return "Renderer flow passed.";
}
