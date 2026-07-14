import { expect, test } from "@playwright/test";

test("loads the Phaser canvas beside a keyboard-operable semantic React overlay", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gameish" })).toBeVisible();

  const focusCheck = page.getByRole("button", { name: "Focus check" });
  await focusCheck.focus();
  await expect(focusCheck).toBeFocused();

  const beforeResize = await canvas.boundingBox();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(async () => (await canvas.boundingBox())?.width)
    .not.toBe(beforeResize?.width);
});
