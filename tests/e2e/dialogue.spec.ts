import { expect, test } from "@playwright/test";

test("opens a private NPC conversation with keyboard-operable scaled dialogue", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Return to world" }).click();
  await page.keyboard.press("KeyE");

  const dialogue = page.getByRole("dialog");
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toContainText("The forest trail is restless today");
  await expect(
    dialogue.getByRole("button", { name: "What happened in the forest?" }),
  ).toBeVisible();
  await expect(dialogue.getByRole("button", { name: "Close" })).toBeFocused();

  const scale = dialogue.getByLabel("Dialogue text scale");
  await scale.fill("1.5");
  await expect(dialogue).toHaveCSS("font-size", "24px");

  await dialogue
    .getByRole("button", { name: "What happened in the forest?" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(dialogue).toContainText("The mossbacks have wandered close");
  await expect(
    dialogue.getByRole("button", { name: /I will look/ }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialogue).toBeHidden();
  await expect(page.locator("#world-root canvas")).toBeFocused();
});
