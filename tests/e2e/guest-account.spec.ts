import { expect, test } from "@playwright/test";

test.skip(
  process.env.RUN_ACCOUNT_E2E !== "true",
  "Set RUN_ACCOUNT_E2E=true after starting the disposable PostgreSQL database and applying migrations.",
);

test("creates, reloads, and rejoins a durable guest character", async ({
  page,
}) => {
  await page.goto("/?account=1");
  await expect(
    page.getByRole("heading", { name: "Enter the village" }),
  ).toBeVisible();

  await page.getByLabel("Character name").fill("Browser Ranger");
  await page.getByRole("button", { name: "Create character" }).click();
  await expect(
    page.getByRole("heading", { name: "Village presence test" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose a character" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Enter as Browser Ranger" }).click();
  await expect(
    page.getByRole("heading", { name: "Village presence test" }),
  ).toBeVisible({ timeout: 15_000 });
});
