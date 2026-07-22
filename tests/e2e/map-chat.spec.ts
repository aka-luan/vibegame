import { expect, test } from "@playwright/test";

test("opens controlled map chat without stealing semantic control activation", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#world-root canvas");
  const returnToWorld = page.getByRole("button", { name: "Return to world" });
  const chatInput = page.getByRole("textbox", { name: "Message current map" });
  await expect(chatInput).toBeVisible();

  await returnToWorld.focus();
  await page.keyboard.press("Enter");
  await expect(canvas).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(chatInput).toBeFocused();
  await chatInput.fill("Hello from keyboard");
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-messages li")).toContainText(
    "Hello from keyboard",
  );
});
