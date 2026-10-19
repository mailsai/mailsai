# @mailsai/playwright

A Playwright fixture for testing the email your app sends at sign-up, sign-in and password reset. Each test gets an email address of its own, a plus address of one mails.ai agent, then waits for the email sent to that address and reads the code or the link in it.

```ts
test("signs up with the emailed code", async ({ page, mails }) => {
  await page.getByLabel("Email").fill(mails.address());
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Code").fill(await mails.waitForCode());
});
```

## What you need

- A mails.ai API key with the `read` scope.
- A mails.ai agent whose receiving address gets the test mail, such as `qa.acme@in.mails.ai`. Mail to any plus address of it, such as `qa.acme+run-1842@in.mails.ai`, reaches the same agent.
- Playwright Test (`@playwright/test`) 1.39 or later.
- Node.js 20.19 or later, or 22.12 or later: the package is an ES module, and a CommonJS project (no `"type": "module"` in its package.json) can load one only on those versions.

## Install

```sh
npm install --save-dev @mailsai/playwright
```

Then add the fixture to Playwright's `test`, once, in a file your specs import:

```ts
// tests/fixtures.ts
import { test as base, expect } from "@playwright/test";
import { mailsFixtures } from "@mailsai/playwright";

export const test = base.extend(mailsFixtures());
export { expect };
```

Specs import `test` and `expect` from that file instead of from `@playwright/test`, and each test can ask for `mails`.

## Settings

Set them as environment variables where the tests run, so no key is written into the repository:

```sh
MAILS_API_KEY=mk_live_… MAILS_RECEIVING_ADDRESS=qa.acme@in.mails.ai npx playwright test
```

| Setting | |
| --- | --- |
| `MAILS_API_KEY` | Required by the waits. |
| `MAILS_RECEIVING_ADDRESS` | Required by `mails.address()`: the receiving address of the agent the test mail goes to. `GET /v1/agents/{id}` returns it as `receiving_address`. |
| `MAILS_BASE_URL` | Optional. `https://api.mails.ai` when unset. |
| `MAILS_AGENT_ID` | Optional. The waits' `agentId` when they are not given one. |

Or pass them to the fixture as options, which take the place of the variables: `apiKey`, `receivingAddress`, `baseUrl` and `agentId`, plus `fetch`, the fetch the requests are made with.

```ts
export const test = base.extend(mailsFixtures({ receivingAddress: "qa.acme@in.mails.ai" }));
```

The key never appears in a step title, an error, the report or a trace. It is not a property of the `mails` object, and the requests are made by `@mailsai/sdk` with Node's `fetch`, not with Playwright's `request` fixture, whose calls a trace records.

## Example

A sign-up that sends a 6-digit code:

```ts
// tests/signup.spec.ts
import { test, expect } from "./fixtures";

test("verifies a new account with the emailed code", async ({ page, mails }) => {
  const email = mails.address();
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Create account" }).click();

  const code = await mails.waitForCode();
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page.getByText("Your account is verified")).toBeVisible();
});
```

For a sign-in link or a password reset, wait for the link and open it:

```ts
await page.goto(await mails.waitForLink({ kind: "reset_password" }));
```

## The `mails` fixture

### `mails.address(tag?)`

Returns a new address for the test: `MAILS_RECEIVING_ADDRESS` with `+<tag>` before the `@`. Without a tag, each call makes a new one from `run-`, the time and 4 random characters, such as `qa.acme+run-mgt2k4x1-7q3z@in.mails.ai`. The waits that follow take only mail sent to the last address it made, unless they are given `to`.

A tag is 1 to 40 letters, digits, `.`, `_`, `-` or `+`, and is lowercased. Pass a tag of your own when the address must be known in advance, such as `mails.address("checkout")`. Mail sent to it by an earlier run then counts too, unless the wait is given `since`.

The part of an address before the `@` holds at most 64 characters, the `+` and the tag included. When the receiving address leaves room for fewer than the 17 characters of the default tag, the default is as many random characters as fit. With room for fewer than 6, `mails.address()` throws and says how much room there is, as it does for a tag of your own that is too long.

### `mails.waitForMessage(options?)`

Returns the newest received email that matches the options, waiting for one to arrive.

| Option | |
| --- | --- |
| `to` | Only mail sent to this address. The last address `mails.address()` made when not given, so an email meant for another test is never taken. |
| `from` | Only mail from this address (`noreply@github.com`), or from this domain and its subdomains (`github.com`). |
| `has` | `"code"`: only mail with a verification code. `"link"`: only mail with a verify, sign-in or password-reset link. |
| `since` | Only mail received at or after this time: an ISO 8601 string, or a `Date`. Without it, the API looks back 5 minutes, so an email that arrived just before the wait began still counts. |
| `timeout` | Seconds to wait in all, 60 when not given. The wait calls the API for at most 50 seconds at a time until the time is used up. |
| `agentId` | Only this agent's mail. `MAILS_AGENT_ID` when not given. |

The message it returns carries `codes` and `links` (below), `subject`, `from`, `delivered_to` (the address it was sent to) and the other fields of a received message in the API reference.

When nothing arrives in time, the wait fails with a message that names the filters:

```
mails.waitForCode: no email arrived within 60 s matching to: qa.acme+run-mgt2k4x1-7q3z@in.mails.ai, has: code.
```

A wait returns the newest matching email, so when a test asks the app for a second email at the same address, such as a second code, pass `since`: the time just before it asked. `since` is compared with the time mails.ai received the email, so it needs a clock that keeps good time.

```ts
const asked = new Date();
await page.getByRole("button", { name: "Send a new code" }).click();
const second = await mails.waitForCode({ since: asked });
```

### `mails.waitForCode(options?)`

Waits as `mails.waitForMessage` does, for mail with a code, and returns the code: `codes[0].value`, the most likely code in the email. Takes the same options, without `has`.

### `mails.waitForLink(options?)`

Waits as `mails.waitForMessage` does, for mail with a verify, sign-in or password-reset link, and returns a URL. Takes the same options, without `has`, and one more:

| Option | |
| --- | --- |
| `kind` | `"verify"`, `"sign_in"`, `"reset_password"` or `"other"`: return the first link of this kind. Without it, the first `verify`, `sign_in` or `reset_password` link. |

It never returns an unsubscribe link, and fails when the email has no link it may return. Only mail with a verify, sign-in or password-reset link is waited for, so `kind: "other"` finds a link of that kind only in such an email.

## Steps and timeouts

Each wait runs as a step of the test, titled with its filters (`mails.waitForCode to: qa.acme+run-mgt2k4x1-7q3z@in.mails.ai, has: code, within 60 s`), so the report and the trace show what it waited for, and a failure is reported at the line of your test that called it.

Playwright gives a test 30 seconds by default, and a wait takes up to 60. While a wait runs, the fixture adds the wait's `timeout`, and 30 seconds for the requests, to the test's timeout, then takes back what the wait did not use. So a wait that finds nothing fails with its own message, naming its filters, rather than with Playwright's test timeout, and afterwards the test has as much time left as it had before the wait began. A test with no timeout is left alone.

## Without the fixture

`createMails(options?)` returns the same object for a test that does not use the fixture, or for code outside a test. It takes the same options as `mailsFixtures()`, and its waits likewise take mail sent to the last address it made when they are not given `to`.

```ts
import { test } from "@playwright/test";
import { createMails } from "@mailsai/playwright";

const mails = createMails();

test("signs up", async ({ page }) => {
  test.slow();
  const email = mails.address();
  // …sign up with `email`…
  const code = await mails.waitForCode();
});
```

Its waits are not steps, and they count toward the test's timeout like any other code: give the test the time with `test.slow()`, which triples it, or `test.setTimeout()`.

## When a call is refused

A refused call fails the wait with the API's error code and message, such as:

```
mails.waitForCode: mails.ai answered 401 invalid_api_key: Invalid API key (request req_…)
```

The error is a `MailsaiApiError`, which is a `MailsError` of `@mailsai/sdk`, with the API's `status`, `code`, `type`, `param` and `requestId`, and on a 402 its `upgradeUrl`. This package exports `MailsError` too, the same class, so `err instanceof MailsError` needs no second import.

The API takes 60 waits a minute for one workspace. When it answers 429, the wait pauses for as long as the answer asks and tries again, as long as what is left of its `timeout` covers the pause.

Past the plan's daily plus-address limit, a wait given `to` fails at once with 402 `plan_limit_exceeded` instead of running out its `timeout`, and its message ends with the link to change plan:

```
mails.waitForCode: mails.ai answered 402 plan_limit_exceeded: Mail to qa.acme+run-mgt2k4x1-7q3z@in.mails.ai arrived but was not kept: … Change your plan: https://app.mails.ai/billing (request req_…)
```

## Limits

A workspace can receive mail at this many different plus addresses in any 24 hours:

| Plan | Plus addresses in 24 hours |
| --- | --- |
| Free | 20 |
| Pro | 1,000 |
| Scale | 10,000 |

An address that already received mail in that time keeps receiving it, so a test's second email always arrives. Past the limit, mail to a new plus address keeps only a record, which a wait never returns, and a wait with that address as `to` fails at once with the 402 above. Each `mails.address()` without a tag is a new address, so a suite of 30 such tests that runs twice a day uses 60 addresses a day. Mail made with `POST /v1/test/inbound` is not counted. The limits for each plan are at https://mails.ai/docs/limits.

A sign-in code, or a verify, sign-in or password-reset link, from a service such as Google, Microsoft's account team, Apple, a payment app or a bank never reaches a plus address either: such mail keeps only a record, so a wait for it runs out its `timeout`. Unless your app is one of those services, its own emails are not affected.

More on testing sign-up email with mails.ai, in Playwright and Cypress: https://mails.ai/docs/email-testing

## Tests

[`packages/playwright/e2e`](https://github.com/mailsai/mailsai/tree/main/packages/playwright/e2e) in the repository is a Playwright project that uses the fixture the way a test suite would, against a stand-in for the mails.ai API and a small sign-up page. In `packages/playwright`, `npm run test:e2e` builds and packs the package, installs it there with Chromium's headless shell and runs it. `npm test` builds the package and runs the unit tests.

## License

MIT
