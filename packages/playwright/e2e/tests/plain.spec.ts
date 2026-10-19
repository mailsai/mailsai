// The plain form: createMails() in a test that does not use the fixture, made once for the file.

import { test, expect } from "@playwright/test";
import { createMails } from "@mailsai/playwright";

const mails = createMails();

test("signs up with createMails(), without the fixture", async ({ page, request }) => {
  // Without the fixture, a wait counts toward the test's timeout, as the README says.
  test.slow();
  const email = mails.address();
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up" }).click();

  const code = await mails.waitForCode({ to: email });

  const state = await (await request.get(`/test/state?email=${encodeURIComponent(email)}`)).json();
  expect(code).toBe(state.code);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Your account is verified");
});

test("waits for the last address it made when not given `to`", async ({ request }) => {
  const email = mails.address();
  await request.post("/test/deliver", { data: { to: email, codes: [{ value: "424242" }], delayMs: 300 } });
  expect(await mails.waitForCode({ timeout: 10 })).toBe("424242");
});
