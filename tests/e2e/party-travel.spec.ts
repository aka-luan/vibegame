import { expect, test, type Browser, type Page } from "@playwright/test";

async function partyPage(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(
    `/?name=${encodeURIComponent(name)}&mapId=map:village&entranceId=village_gate`,
  );
  await expect(page.getByRole("heading", { name: "Party" })).toBeVisible();
  return page;
}

async function invite(leader: Page, member: Page, memberName: string) {
  await leader.getByRole("button", { name: `Invite ${memberName}` }).click();
  await member
    .getByRole("button", { name: `Accept invitation from Leader` })
    .click();
  await expect(member.getByText("Leader — leader — map:village")).toBeVisible();
}

test("forms a three-player party and travels cohesively to the forest", async ({
  browser,
}) => {
  const leader = await partyPage(browser, "Leader");
  const memberOne = await partyPage(browser, "Member One");
  const memberTwo = await partyPage(browser, "Member Two");
  await invite(leader, memberOne, "Member One");
  await invite(leader, memberTwo, "Member Two");

  await leader.getByRole("button", { name: "Travel to the forest" }).click();
  for (const page of [leader, memberOne, memberTwo]) {
    await expect(
      page.getByRole("button", { name: "Travel to the village" }),
    ).toBeVisible({ timeout: 10_000 });
  }
});

test("travels to an eligible party member in another map instance", async ({
  browser,
}) => {
  const leader = await partyPage(browser, "Leader");
  const member = await partyPage(browser, "Member");
  await invite(leader, member, "Member");

  await member
    .getByRole("button", {
      name: "Travel to the forest alone — party stays here",
    })
    .click();
  await expect(
    member.getByRole("button", { name: "Travel to the village" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(leader.getByText("Member — map:forest")).toBeVisible({
    timeout: 10_000,
  });

  await leader.getByRole("button", { name: "Travel to Member" }).click();
  await expect(
    leader.getByRole("button", { name: "Travel to the village" }),
  ).toBeVisible({ timeout: 10_000 });
});
