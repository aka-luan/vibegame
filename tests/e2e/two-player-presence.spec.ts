import { expect, test } from "@playwright/test";

test("two browser contexts see each other in the village", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  await Promise.all([
    first.goto("/?name=First%20Ranger"),
    second.goto("/?name=Second%20Ranger"),
  ]);

  await Promise.all([
    expect(first.getByText("2 players connected")).toBeVisible(),
    expect(second.getByText("2 players connected")).toBeVisible(),
  ]);
  await expect(first.locator("#world-root canvas")).toHaveAttribute(
    "data-public-player-count",
    "2",
  );
  await expect(second.locator("#world-root canvas")).toHaveAttribute(
    "data-public-player-count",
    "2",
  );
  await expect(first.locator("#world-root canvas")).toHaveAttribute(
    "data-public-player-names",
    /Second Ranger/,
  );
  await expect(second.locator("#world-root canvas")).toHaveAttribute(
    "data-public-player-names",
    /First Ranger/,
  );

  const roomInspection = first.getByText("Development room inspection");
  await expect(roomInspection).toBeVisible();
  const roomId = await first.locator(".development-overlay code").textContent();
  expect(roomId).toBeTruthy();
  await expect(first.locator(".world-status")).not.toContainText(roomId ?? "");

  const firstCanvas = first.locator("#world-root canvas");
  const secondCanvas = second.locator("#world-root canvas");
  const firstStartX = Number(await firstCanvas.getAttribute("data-player-x"));
  const secondStartX = Number(await secondCanvas.getAttribute("data-player-x"));
  await first.getByRole("button", { name: "Return to world" }).click();
  await second.getByRole("button", { name: "Return to world" }).click();
  await Promise.all([
    first.keyboard.down("KeyD"),
    second.keyboard.down("KeyA"),
  ]);
  await Promise.all([
    expect
      .poll(async () => Number(await firstCanvas.getAttribute("data-player-x")))
      .toBeGreaterThan(firstStartX),
    expect
      .poll(async () =>
        Number(await secondCanvas.getAttribute("data-player-x")),
      )
      .toBeLessThan(secondStartX),
  ]);
  await Promise.all([first.keyboard.up("KeyD"), second.keyboard.up("KeyA")]);

  await Promise.all([firstContext.close(), secondContext.close()]);
});

test("two-player presence survives a short browser interruption", async ({
  browser,
}) => {
  const reconnectingContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const reconnecting = await reconnectingContext.newPage();
  const observer = await observerContext.newPage();

  await Promise.all([
    reconnecting.goto("/?name=Returning%20Ranger&latency=200"),
    observer.goto("/?name=Patient%20Ranger"),
  ]);
  await Promise.all([
    expect(reconnecting.getByText("2 players connected")).toBeVisible(),
    expect(observer.getByText("2 players connected")).toBeVisible(),
  ]);

  await reconnectingContext.setOffline(true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect(observer.getByText("2 players connected")).toBeVisible();
  await reconnectingContext.setOffline(false);

  await expect(reconnecting.getByText("Network connected")).toBeVisible({
    timeout: 5_000,
  });
  await Promise.all([
    expect(reconnecting.getByText("2 players connected")).toBeVisible(),
    expect(observer.getByText("2 players connected")).toBeVisible(),
  ]);

  await Promise.all([reconnectingContext.close(), observerContext.close()]);
});
