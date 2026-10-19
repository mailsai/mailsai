// The failure paths. Each wait that should fail is awaited with failureOf(), which throws when the
// wait succeeds instead, so a wait that wrongly succeeds cannot pass vacuously; then the message is
// checked word for word. How the same failures look as real failed tests, in Playwright's own
// report, is the report run's job (tests/report).
//
// MailsError comes from @mailsai/playwright, which re-exports @mailsai/sdk's class, so these checks
// also prove the re-export is the class the waits throw.

import { MailsaiApiError, MailsError } from "@mailsai/playwright";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, failureOf, keyIsNotIn, type StubCall } from "./fixtures";

const callsOf = async (request: APIRequestContext, email: string): Promise<StubCall[]> =>
  (await request.get(`/test/calls?to=${encodeURIComponent(email)}`)).json();

test.describe("failures of @mailsai/playwright", () => {
  test("rejects naming the filters when nothing arrives within a short timeout", async ({ mails }) => {
    const email = mails.address();
    const err = await failureOf(mails.waitForCode({ timeout: 2 }));
    expect(err.message).toBe(`mails.waitForCode: no email arrived within 2 s matching to: ${email}, has: code.`);
    keyIsNotIn(err.message);
  });

  test("spends a 60 s timeout as a 50 s wait and a 10 s wait (the stub holds 1/50 of each)", async ({ request, mails }) => {
    const email = mails.address("fast-" + Date.now().toString(36));
    const err = await failureOf(mails.waitForMessage());
    expect(err.message).toBe(`mails.waitForMessage: no email arrived within 60 s matching to: ${email}.`);
    const calls = await callsOf(request, email);
    expect(calls.map((c) => c.timeout)).toEqual([50, 10]);
    expect(calls.every((c) => c.has === null)).toBe(true);
  });

  test("rejects with the API's error code and message", async ({ mails }) => {
    mails.address("forbidden-" + Date.now().toString(36));
    const err = await failureOf(mails.waitForCode({ timeout: 5 }));
    expect(err.message).toMatch(/^mails\.waitForCode: mails\.ai answered 403 insufficient_scope: This API key does not have the read scope\. \(request req_stub_\d+\)$/);
  });

  test("rejects at once, with the link to change plan, when the plan's daily plus-address limit refused the mail", async ({ request, mails }) => {
    const email = mails.address("planlimit-" + Date.now().toString(36));
    const started = Date.now();
    const err = await failureOf(mails.waitForCode());
    expect(Date.now() - started, "at once, not after the 60 s timeout").toBeLessThan(3000);
    const escaped = email.replace(/[.+]/g, "\\$&");
    expect(err.message).toMatch(
      new RegExp(
        `^mails\\.waitForCode: mails\\.ai answered 402 plan_limit_exceeded: Mail to ${escaped} arrived but was not kept: .* Upgrade, or reuse a plus address that already received mail today\\. Change your plan: https://app\\.mails\\.ai/billing \\(request req_stub_\\d+\\)$`
      )
    );
    expect(err).toBeInstanceOf(MailsaiApiError);
    expect(err).toBeInstanceOf(MailsError);
    const paid = err as MailsaiApiError;
    expect([paid.status, paid.code, paid.upgradeUrl]).toEqual([402, "plan_limit_exceeded", "https://app.mails.ai/billing"]);
    // One call, no retry.
    expect((await callsOf(request, email)).map((c) => [c.timeout, c.status])).toEqual([[50, 402]]);
  });

  test("refuses a misspelt option before making any request", async ({ mails }) => {
    // @ts-expect-error: "To" is not an option, and the types say so too.
    const err = await failureOf(mails.waitForLink({ To: "qa.stub+x@in.mails.test" }));
    expect(err.message).toBe('mails.waitForLink has no option "To". Its options are to, from, since, timeout, agentId, kind.');
  });

  test("refuses an empty to rather than waiting for anyone's mail", async ({ mails }) => {
    const err = await failureOf(mails.waitForCode({ to: "" }));
    expect(err.message).toBe("mails.waitForCode: to is empty. Give a value, or leave to out.");
  });

  test("rejects without the key when the API never answers (the request's deadline)", async ({ mails }) => {
    const email = mails.address("hang-" + Date.now().toString(36));
    const err = await failureOf(mails.waitForCode({ timeout: 0 }));
    expect(err.message).toBe(`mails.waitForCode: mails.ai at ${process.env.MAILS_BASE_URL} did not answer within 15 s (a wait of 0 s for mail matching to: ${email}, has: code).`);
    keyIsNotIn(err.message);
    expect(err.message.toLowerCase()).not.toContain("bearer");
  });

  test("a wait is not cut short by the test's timeout, and gives back the time it did not use", async ({ mails }, testInfo) => {
    test.setTimeout(3_000);
    const email = mails.address();
    const started = Date.now();
    // 5 s of waiting in a test of 3 s: without the fixture's extension, Playwright would end the
    // test at 3 s with its own "Test timeout of 3000ms exceeded".
    const err = await failureOf(mails.waitForCode({ timeout: 5 }));
    const took = Date.now() - started;
    expect(err.message).toBe(`mails.waitForCode: no email arrived within 5 s matching to: ${email}, has: code.`);
    expect(took).toBeGreaterThanOrEqual(5_000);
    // After the wait, the test has what it had before: its 3 s plus the time the wait took.
    expect(Math.abs(testInfo.timeout - (3_000 + took))).toBeLessThan(250);
  });
});
