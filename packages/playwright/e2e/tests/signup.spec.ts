// The happy paths, as a user would write them: a plus address per test, the code or link sent to it.

import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, type SignupState, type StubCall } from "./fixtures";

async function signUp(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a code");
}

const stateOf = async (request: APIRequestContext, email: string): Promise<SignupState> =>
  (await request.get(`/test/state?email=${encodeURIComponent(email)}`)).json();
const callsOf = async (request: APIRequestContext, email: string): Promise<StubCall[]> =>
  (await request.get(`/test/calls?to=${encodeURIComponent(email)}`)).json();

const LONG_TITLE =
  "a test whose title is very long, " +
  "and goes on and on ".repeat(12) +
  `with quotes " ' \`, slashes / \\, a plus + and an at @, and émail, 测试, 🚀 in it: it gets an address of the usual shape, and the code`;

test.describe("sign-up with @mailsai/playwright", () => {
  test("signs up with a plus address and types the code sent to it, not the decoy's", async ({ page, request, mails }) => {
    const email = mails.address();
    expect(email).toMatch(/^qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
    await signUp(page, email);

    const code = await mails.waitForCode();

    const state = await stateOf(request, email);
    expect(code, "the code of the email sent to this address").toBe(state.code);
    expect(code, "not the decoy's code").not.toBe(state.decoyCode);
    expect(state.decoyAddress).not.toBe(email);
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("status")).toHaveText("Your account is verified");
  });

  test("opens the verify link sent to this address, never its unsubscribe link", async ({ page, request, mails, baseURL }) => {
    const email = mails.address();
    await signUp(page, email);

    const url = await mails.waitForLink();

    const state = await stateOf(request, email);
    expect(url).toBe(`${baseURL}/verify?token=${state.token}`);
    expect(url).not.toContain(state.decoyToken);
    expect(url).not.toContain("unsubscribe");
    await page.goto(url);
    await expect(page.getByRole("status")).toHaveText(`Email verified for ${email}`);
  });

  test("returns the first link of the kind asked for", async ({ page, mails, baseURL }) => {
    const email = mails.address("kind-" + Date.now().toString(36));
    expect(email).toMatch(/^qa\.stub\+kind-[0-9a-z]+@in\.mails\.test$/);
    await signUp(page, email);
    expect(await mails.waitForLink({ kind: "other" })).toBe(`${baseURL}/help`);
    expect(await mails.waitForLink({ kind: "verify" })).toMatch(/\/verify\?token=[0-9a-f]{16}$/);
  });

  test("returns the whole message for the address it was sent to", async ({ page, mails }) => {
    const email = mails.address();
    await signUp(page, email);
    const message = await mails.waitForMessage({ has: "code", from: "app.test", timeout: 20 });
    expect(message.delivered_to).toBe(email);
    expect(message.subject).toBe("Confirm your email");
    expect(message.codes).toHaveLength(1);
    expect(message.links?.map((l) => l.kind)).toEqual(["unsubscribe", "other", "verify"]);
  });

  test("waits out a 429 and tries again within the same timeout", async ({ request, mails }) => {
    const email = mails.address("limited-" + Date.now().toString(36));
    await request.post("/test/deliver", { data: { to: email, codes: [{ value: "777111" }], links: [], subject: "Your code" } });
    expect(await mails.waitForCode({ timeout: 10 })).toBe("777111");
    const calls = await callsOf(request, email);
    expect(calls.map((c) => c.status)).toEqual([429, 200]);
    // The 1 s pause came out of the 10 s timeout.
    expect(calls.map((c) => c.timeout)).toEqual([10, 9]);
  });

  test("takes a second email to the same address only when given since", async ({ request, mails }) => {
    const email = mails.address();
    await request.post("/test/deliver", { data: { to: email, codes: [{ value: "111111" }] } });
    expect(await mails.waitForCode()).toBe("111111");

    const asked = new Date();
    await request.post("/test/deliver", { data: { to: email, codes: [{ value: "222222" }], delayMs: 1500 } });
    // Without since, the first email still matches, and is the newest until the second arrives.
    expect(await mails.waitForCode()).toBe("111111");
    expect(await mails.waitForCode({ since: asked })).toBe("222222");
    const calls = await callsOf(request, email);
    expect(calls.map((c) => c.since)).toEqual([null, null, asked.toISOString()]);
  });

  test("waits for mail to the last address made, or to the one given", async ({ request, mails }) => {
    const first = mails.address();
    const second = mails.address();
    expect(second).not.toBe(first);
    await request.post("/test/deliver", { data: { to: first, codes: [{ value: "100001" }] } });
    await request.post("/test/deliver", { data: { to: second, codes: [{ value: "200002" }] } });
    expect(await mails.waitForCode()).toBe("200002");
    expect(await mails.waitForCode({ to: first })).toBe("100001");
  });

  test(LONG_TITLE, async ({ page, request, mails }, testInfo) => {
    expect(testInfo.title).toBe(LONG_TITLE);
    expect(LONG_TITLE.length).toBeGreaterThan(300);
    const email = mails.address();
    // The title does not go into the address: the same tag as any other test, well inside 64.
    expect(email).toMatch(/^qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
    expect(email.split("@")[0].length).toBeLessThanOrEqual(64);
    await signUp(page, email);
    const code = await mails.waitForCode();
    expect(code).toBe((await stateOf(request, email)).code);
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("status")).toHaveText("Your account is verified");
  });
});
