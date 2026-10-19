// @mailsai/playwright: a Playwright fixture for testing the email an app sends at sign-up, sign-in
// and password reset. Each test gets an address of its own, a plus address of one mails.ai agent,
// then waits for the email sent to it and reads the code or the link:
//
//   import { test as base } from "@playwright/test";
//   import { mailsFixtures } from "@mailsai/playwright";
//   export const test = base.extend(mailsFixtures());
//
//   test("sign up", async ({ page, mails }) => {
//     await page.getByLabel("Email").fill(mails.address());   // a new plus address
//     …
//     const code = await mails.waitForCode();                 // waits for mail sent to it
//   });
//
// Each wait runs as a step of the test, titled with its filters and reported at the line that
// called it. While it runs, the test's timeout is extended by the wait's own, so a wait that finds
// nothing fails with its own message, naming the filters, rather than with Playwright's test
// timeout; afterwards the test has as much time left as it had before the wait began.
// createMails() is the same object without the fixture. The logic is in core.ts and client.ts.

import { test } from "@playwright/test";
import type { Fixtures, TestInfo } from "@playwright/test";
import { checkOptions, REQUEST_GRACE_SECONDS, type MailsOptions } from "./core.js";
import { makeMails, type Mails } from "./client.js";

export { createMails, type Mails } from "./client.js";
export { MailsaiApiError } from "./core.js";
// The SDK's error class, which MailsaiApiError extends, for `err instanceof MailsError` without a
// second import: the same class as @mailsai/sdk's.
export { MailsError } from "@mailsai/sdk";
export type {
  LinkKind,
  MailsaiLinkKind,
  MailsaiReceivedMessage,
  MailsaiWaitForCodeOptions,
  MailsaiWaitForLinkOptions,
  MailsaiWaitOptions,
  MailsOptions,
} from "./core.js";

/** The fixture mailsFixtures() adds: `mails`, one per test. */
export type MailsFixtures = { mails: Mails };

/** Runs `run` with time for a wait of `seconds` added to the test's timeout (the wait's own
 *  timeout, and a request's grace twice over), then gives back what it did not use. A test with
 *  no timeout (0) is left alone. */
async function withTimeFor<T>(testInfo: TestInfo, seconds: number, run: () => Promise<T>): Promise<T> {
  if (testInfo.timeout === 0) return run();
  const extra = (seconds + 2 * REQUEST_GRACE_SECONDS) * 1000;
  const start = Date.now();
  testInfo.setTimeout(testInfo.timeout + extra);
  try {
    return await run();
  } finally {
    if (testInfo.timeout !== 0) testInfo.setTimeout(testInfo.timeout - extra + (Date.now() - start));
  }
}

/**
 * The `mails` fixture, for `test.extend()`: a new mails object for each test, whose waits run as
 * steps of the test. Each setting left out of `options` is read from its environment variable
 * (MAILS_API_KEY, MAILS_RECEIVING_ADDRESS, MAILS_BASE_URL, MAILS_AGENT_ID) when it is needed.
 * @example export const test = base.extend(mailsFixtures());
 */
export function mailsFixtures(options?: MailsOptions): Fixtures<MailsFixtures> {
  checkOptions("mailsFixtures", options);
  return {
    mails: async ({}, use, testInfo) => {
      await use(
        // A boxed step: a failure inside it is reported at the line of the test that called the
        // wait. Playwright finds that line in the stack it takes as the step begins, which reaches
        // the test only because each function between them awaits the next.
        makeMails("mailsFixtures", options, async (title, seconds, location, run) =>
          await test.step(title, () => withTimeFor(testInfo, seconds, run), { box: true, ...(location ? { location } : {}) })
        )
      );
    },
  };
}
