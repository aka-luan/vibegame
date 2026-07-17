import { expect, test } from "@playwright/test";

test("diagonal movement keeps the room connected", async ({ page }) => {
  await page.goto("/?name=Diagonal%20Ranger");

  const status = page.locator(".world-status");
  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toHaveAttribute("data-public-player-count", "1", {
    timeout: 15_000,
  });
  await expect(status).toContainText("Network connected");
  const initialX = Number(await canvas.getAttribute("data-player-x"));
  const initialY = Number(await canvas.getAttribute("data-player-y"));

  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.down("KeyD");
  await page.keyboard.down("KeyW");
  const observedStatuses: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    observedStatuses.push((await status.textContent()) ?? "");
    await page.waitForTimeout(25);
  }
  await page.keyboard.up("KeyW");
  await page.keyboard.up("KeyD");

  expect(
    observedStatuses.every((value) => value.includes("Network connected")),
  ).toBe(true);
  await expect(status).toContainText("Network connected");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-player-x")))
    .toBeGreaterThan(initialX);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-player-y")))
    .toBeLessThan(initialY);
});
