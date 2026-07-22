import { expect, test } from "@playwright/test";

test("travels through a real portal transition from the village to the forest and back", async ({
  page,
}) => {
  // The dev/test-only spawn override (`mapId`/`entranceId`, documented on
  // `DevelopmentPlayTickets#issue`) lands the player next to the village's
  // portal without walking the full ~1280px map — the transition itself
  // still goes through the real portal id -> server ticket -> destination
  // room flow; nothing about that path is shortcut.
  await page.goto("/?mapId=map:village&entranceId=village_gate");

  const travelToForest = page.getByRole("button", {
    name: "Travel to the forest",
  });
  await expect(travelToForest).toBeVisible();
  await expect(travelToForest).toBeEnabled();

  const canvas = page.locator("#world-root canvas");
  await expect(canvas).toBeVisible();
  const villageX = Number(await canvas.getAttribute("data-player-x"));
  expect(villageX).toBeGreaterThan(1000);

  await travelToForest.click();

  // The village-side control disappears and the forest-side control
  // appears once the destination room's snapshot reports the player next
  // to `portal_village_gate` — proof the client actually rejoined a
  // different room rather than just relabeling a button.
  const travelToVillage = page.getByRole("button", {
    name: "Travel to the village",
  });
  await expect(travelToVillage).toBeVisible({ timeout: 10_000 });
  await expect(travelToForest).toBeHidden();

  await expect
    .poll(async () => Number(await canvas.getAttribute("data-player-x")), {
      timeout: 10_000,
    })
    .toBeLessThan(200);

  // The portal cooldown is per character and outlives the room change, so
  // the return trip has to wait it out the same way a player would.
  await page.waitForTimeout(2_500);
  await travelToVillage.click();

  await expect(travelToForest).toBeVisible({ timeout: 10_000 });
  await expect(travelToVillage).toBeHidden();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-player-x")), {
      timeout: 10_000,
    })
    .toBeGreaterThan(1000);
});
