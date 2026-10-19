// Tests that FAIL on purpose: run.mjs's report run expects this file to fail and then reads
// Playwright's JSON report, to check what a user sees when a wait fails in a real test: the
// message, the line it is reported at (each line is marked "report-line: <name>"), the step it ran
// as, and how long it took. The last test is the control: the same wait without the fixture, cut
// short by Playwright's test timeout.

import { test as base } from "@playwright/test";
import { createMails, mailsFixtures } from "@mailsai/playwright";

const test = base.extend(mailsFixtures());

test("a wait that finds nothing fails with its own message, naming its filters", async ({ mails }) => {
  test.setTimeout(3_000);
  mails.address();
  await mails.waitForCode({ timeout: 4 }); // report-line: nothing
});

test("a 402 fails at once with the link to change plan", async ({ mails }) => {
  mails.address("planlimit-" + Date.now().toString(36));
  await mails.waitForLink(); // report-line: planlimit
});

test("a misspelt option fails at the line that has it", async ({ mails }) => {
  // @ts-expect-error: "kinds" is not an option.
  await mails.waitForLink({ kinds: "verify" }); // report-line: option
});

test("control: without the fixture, Playwright's test timeout ends the same wait first", async () => {
  test.setTimeout(3_000);
  const mails = createMails();
  mails.address();
  await mails.waitForCode({ timeout: 4 }); // report-line: control
});
