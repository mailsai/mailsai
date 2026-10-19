// Run on its own, twice: once with no MAILS_API_KEY at all, and once with MAILS_BASE_URL pointing
// at a closed port. RUN_KIND, which run.mjs sets, says which.

import { test, expect, failureOf, keyIsNotIn } from "./fixtures";

test.describe("settings of @mailsai/playwright", () => {
  test("makes an address without an API key, and fails a wait clearly without one", async ({ mails }) => {
    test.skip(process.env.RUN_KIND !== "missing-key", "the missing-key run");
    expect(process.env.MAILS_API_KEY).toBeUndefined();
    expect(mails.address("nokey")).toBe("qa.stub+nokey@in.mails.test");
    const err = await failureOf(mails.waitForCode());
    expect(err.message).toBe(
      "mails.waitForCode needs MAILS_API_KEY: a mails.ai API key with the read scope. Set the environment variable MAILS_API_KEY where the tests run, or pass apiKey to mailsFixtures() or createMails()."
    );
  });

  test("fails without the key when the API cannot be reached", async ({ mails }) => {
    test.skip(process.env.RUN_KIND !== "closed-port", "the closed-port run");
    const base = process.env.MAILS_BASE_URL ?? "";
    mails.address("closed");
    const err = await failureOf(mails.waitForCode({ timeout: 0 }));
    const port = new URL(base).port;
    expect(err.message).toBe(`mails.waitForCode: could not reach mails.ai at ${base}: connect ECONNREFUSED 127.0.0.1:${port}. Is MAILS_BASE_URL the API's address?`);
    keyIsNotIn(err.message);
    expect(err.message.toLowerCase()).not.toContain("bearer");
  });
});
