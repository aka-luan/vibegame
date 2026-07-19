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

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Preview" })
    .click();
  await expect(first.getByRole("status")).toContainText("Previewing tunic");

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Unequip" })
    .click();
  await expect
    .poll(async () => {
      const raw = await second
        .locator("#world-root canvas")
        .getAttribute("data-public-player-armors");
      return raw?.includes('"displayName":"Equipment First","armorLayerId":""');
    })
    .toBe(true);

  await first
    .getByTestId("inventory-item:trailwarden_tunic")
    .getByRole("button", { name: "Equip" })
    .click();
  await expect
    .poll(async () => {
      const raw = await second
        .locator("#world-root canvas")
        .getAttribute("data-public-player-armors");
      return raw?.includes(
        '"displayName":"Equipment First","armorLayerId":"tunic"',
      );
    })
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
  await expect(first.getByRole("status")).toContainText("no armor");

  await Promise.all([firstContext.close(), secondContext.close()]);
});
