async page => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const workspace = page.getByRole("region", { name: "Workspace" });
  await workspace.getByRole("button", { name: /Open folder/ }).click();
  await workspace.getByRole("button", { name: "Trust project" }).click();
  await workspace.getByRole("button", { name: /New session/ }).click();
  await page.getByRole("textbox", { name: "Message Pideck" }).fill("Update and verify the status.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("I updated the status and checked the result.").waitFor();
  await page.getByText("Checks passed.").waitFor();
  await page.getByRole("button", { name: "Toggle review" }).click();
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example.ts/ }).click();
  const split = page.getByRole("button", { name: "Split", exact: true });
  await split.click();
  if (await split.getAttribute("aria-pressed") !== "true") throw new Error("Split layout did not activate.");
  await page.getByRole("complementary", { name: "Review changes" }).locator("diffs-container").filter({ hasText: "verified" }).last().waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  return "Renderer flow passed.";
}
