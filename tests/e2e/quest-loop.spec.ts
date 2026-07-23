import { expect, test } from "@playwright/test";

test("completes the first quest with tracker guidance enabled and disabled", async ({
  page,
}) => {
  await page.goto("/");

  const tracker = page.getByRole("region", { name: "Quest tracker" });
  await expect(tracker).toContainText("Status: available");
  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.press("KeyE");

  const dialogue = page.getByRole("dialog");
  await expect(dialogue).toBeVisible();
  await dialogue
    .getByRole("button", { name: "What happened in the forest?" })
    .click();
  await dialogue
    .getByRole("button", { name: "Accept: Mossbacks Near the Path" })
    .click();
  await expect(tracker).toContainText("Status: active");
  await expect(tracker).toContainText("Guidance: Forest path");
  await expect(tracker).toContainText("Marker: Mossback path");
  await page.keyboard.press("Escape");

  const guidance = tracker.getByLabel("Show guidance");
  await guidance.uncheck();
  await expect(tracker).not.toContainText("Guidance: Forest path");
  await expect(tracker).not.toContainText("Marker: Mossback path");
  await guidance.check();
  await expect(tracker).toContainText("Guidance: Forest path");
  await guidance.uncheck();

  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1_800);
  await page.keyboard.up("KeyD");
  const basicAttack = page.getByRole("button", {
    name: /1 — Trailward Strike/,
  });
  for (let index = 0; index < 8; index += 1) {
    await page.getByRole("button", { name: /Mossback \(/ }).click();
    if (!(await basicAttack.isEnabled())) {
      await page.getByRole("button", { name: "Return to world" }).click();
      await page.keyboard.down("KeyD");
      await page.waitForTimeout(500);
      await page.keyboard.up("KeyD");
      continue;
    }
    await basicAttack.click();
    await page.waitForTimeout(700);
    if (await tracker.getByText(/Status: ready/).count()) break;
  }
  await expect(tracker).toContainText("Status: ready", { timeout: 5_000 });

  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.down("KeyA");
  await expect
    .poll(async () =>
      Number(
        await page.locator("#world-root canvas").getAttribute("data-player-x"),
      ),
    )
    .toBeLessThan(180);
  await page.keyboard.up("KeyA");
  await page.keyboard.press("KeyE");
  await expect(dialogue).toBeVisible();
  await dialogue
    .getByRole("button", { name: "What happened in the forest?" })
    .click();
  await dialogue
    .getByRole("button", { name: "Turn in: Mossbacks Near the Path" })
    .click();
  await expect(tracker).toContainText("Status: completed", { timeout: 5_000 });
  await expect(tracker).toContainText("Reward received");
});
