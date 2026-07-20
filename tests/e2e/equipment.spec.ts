import { expect, test, type Page } from "@playwright/test";

test.skip(
  process.env.RUN_ACCOUNT_E2E !== "true",
  "Set RUN_ACCOUNT_E2E=true after starting the disposable PostgreSQL database and applying migrations.",
);

async function createCharacter(page: Page, name: string) {
  await page.goto("/?account=1");
  await page.getByLabel("Character name").fill(name);
  await page.getByRole("button", { name: "Create character" }).click();
  await expect(
    page.getByRole("heading", { name: "Village presence test" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("inventory-item:trailwarden_tunic"),
  ).toContainText("Trailwarden Tunic");
}

async function earnArmor(page: Page) {
  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1_800);
  await page.keyboard.up("KeyD");
  const target = page.getByRole("button", { name: /Mossback \(/ });
  const attack = page.getByRole("button", { name: /1 — Trailward Strike/ });
  for (let index = 0; index < 8; index += 1) {
    await target.click();
    if (!(await attack.isEnabled())) {
      await page.waitForTimeout(650);
      continue;
    }
    await attack.click();
    await page.waitForTimeout(700);
    if (
      await page
        .getByTestId("inventory-item:trailwarden_tunic")
        .getByText(/×2/)
        .count()
    ) {
      return;
    }
  }
  await expect(
    page.getByTestId("inventory-item:trailwarden_tunic"),
  ).toContainText("×2", { timeout: 5_000 });
}

test("persists preview, equip, and unequip appearance across two browsers", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await Promise.all([
    createCharacter(first, "Equipment First"),
    createCharacter(second, "Equipment Second"),
  ]);
  await earnArmor(first);

  const firstCanvas = first.locator("#world-root canvas");
  const secondCanvas = second.locator("#world-root canvas");
  const remoteWithArmor = await secondCanvas.screenshot();

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Unequip" })
    .click();
  await expect(
    first
      .getByTestId("inventory-item:trailwarden_tunic")
      .getByRole("button", { name: "Equip" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        Buffer.compare(await secondCanvas.screenshot(), remoteWithArmor) !== 0,
    )
    .toBe(true);
  const remoteWithoutArmor = await secondCanvas.screenshot();

  const localWithoutArmor = await firstCanvas.screenshot();
  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Preview" })
    .click();
  await expect(
    first.locator(".equipment-panel").getByRole("status"),
  ).toContainText("Previewing tunic");
  expect(await firstCanvas.screenshot()).not.toEqual(localWithoutArmor);

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Equip" })
    .click();
  await expect(
    first.getByTestId("inventory-item:trailwarden_tunic"),
  ).toContainText("Unequip");
  await expect
    .poll(
      async () =>
        Buffer.compare(await secondCanvas.screenshot(), remoteWithoutArmor) !==
        0,
    )
    .toBe(true);
  await first.reload();
  await expect(
    first.getByRole("heading", { name: "Choose a character" }),
  ).toBeVisible({ timeout: 15_000 });
  await first.getByRole("button", { name: "Enter as Equipment First" }).click();
  await expect(
    first.getByTestId("inventory-item:trailwarden_tunic"),
  ).toContainText("Unequip", { timeout: 15_000 });

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Unequip" })
    .click();
  await expect(
    first
      .getByTestId("inventory-item:trailwarden_tunic")
      .getByRole("button", { name: "Equip" }),
  ).toBeVisible();

  await Promise.all([firstContext.close(), secondContext.close()]);
});
