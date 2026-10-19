// Run on its own (run.mjs's long-address run) with a receiving address whose part before the @ has
// 52 characters, which leaves room for an 11-character tag under the 64-character limit.

import { test, expect } from "./fixtures";

test.describe("@mailsai/playwright with a long receiving address", () => {
  test.beforeEach(() => {
    test.skip(process.env.RUN_KIND !== "long-address", "the long-address run");
  });

  test("shortens the default tag to fill the part before the @ to exactly 64, and the flow still works", async ({ page, mails }) => {
    const email = mails.address();
    expect(email).toMatch(/^q{52}\+[0-9a-z]{11}@in\.mails\.test$/);
    expect(email.split("@")[0]).toHaveLength(64);
    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Sign up" }).click();
    await page.getByLabel("Code").fill(await mails.waitForCode());
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("status")).toHaveText("Your account is verified");
  });

  test("throws naming the room when a tag of your own is too long", async ({ mails }) => {
    expect(() => mails.address("signup-12345")).toThrow(
      new Error(`The part of an address before the @ holds at most 64 characters, so a tag on ${"q".repeat(52)}@in.mails.test can have at most 11. Received 12: "signup-12345"`)
    );
  });
});
