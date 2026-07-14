import { expect, test } from "@playwright/test";

test("loads the production village build and moves by keyboard after focus handoff", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Village walk test" }),
  ).toBeVisible();

  const returnToWorld = page.getByRole("button", { name: "Return to world" });
  await returnToWorld.focus();
  await expect(returnToWorld).toBeFocused();

  const startingX = await canvas.getAttribute("data-player-x");
  await page.keyboard.press("KeyD");
  await expect(canvas).toHaveAttribute("data-player-x", startingX ?? "");

  await returnToWorld.click();
  await expect(canvas).toBeFocused();
  await page.keyboard.down("KeyD");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-player-x")))
    .toBeGreaterThan(Number(startingX));
  await page.keyboard.up("KeyD");
  await expect(canvas).toHaveAttribute("data-facing", "east");

  const beforeResize = await canvas.boundingBox();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(async () => (await canvas.boundingBox())?.width)
    .not.toBe(beforeResize?.width);
});
