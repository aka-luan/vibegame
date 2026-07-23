import { expect, test } from "@playwright/test";

test("loads the production village build and moves by keyboard after focus handoff", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toBeVisible();
  const worldBox = await page.locator("#world-root").boundingBox();
  const uiBox = await page.locator("#ui-root").boundingBox();
  expect(worldBox).not.toBeNull();
  expect(uiBox).not.toBeNull();
  expect(uiBox!.x).toBeGreaterThanOrEqual(worldBox!.x + worldBox!.width - 1);
  await expect(
    page.getByRole("heading", { name: "Village presence test" }),
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

test("opens both keyboard-accessible map views with independent text scaling", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("button", { name: "Map (M)" })).toBeVisible();

  await canvas.focus();
  await page.keyboard.press("M");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Local map" }),
  ).toBeVisible();
  await expect(dialog.getByText("Village").first()).toBeVisible();

  const scale = dialog.getByLabel("Map text scale");
  await scale.press("ArrowRight");
  await expect(scale).toHaveValue("1.05");

  await dialog.getByRole("tab", { name: "World map" }).click();
  await expect(
    dialog.getByRole("heading", { name: "World map" }),
  ).toBeVisible();
  await expect(dialog.getByText("Forest").first()).toBeVisible();
  await expect(dialog).not.toContainText("room");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
