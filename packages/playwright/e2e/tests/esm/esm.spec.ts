// The same sign-up in an ES module project ("type": "module" in this folder's package.json), where
// Playwright loads test files as ES modules; the rest of tests/ is a CommonJS project.

import { test as base, expect } from "@playwright/test";
import { mailsFixtures } from "@mailsai/playwright";

const test = base.extend(mailsFixtures());

test("signs up with the code, in an ES module project", async ({ page, request, mails }) => {
  expect(typeof require, "this file runs as an ES module").toBe("undefined");
  const email = mails.address();
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up" }).click();
  const code = await mails.waitForCode();
  const state = await (await request.get(`/test/state?email=${encodeURIComponent(email)}`)).json();
  expect(code).toBe(state.code);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Your account is verified");
});
