# @mailsai/cypress

Cypress commands for testing the email your app sends at sign-up, sign-in and password reset. Each test run gets an email address of its own, a plus address of one mails.ai agent, then waits for the email sent to that address and reads the code or the link in it.

```ts
cy.mailsaiPlusAddress().then((email) => {
  // …sign up with `email`…
  cy.mailsaiWaitForCode({ to: email }).then((code) => cy.get("[data-cy=code]").type(code));
});
```

## What you need

- A mails.ai API key with the `read` scope.
- A mails.ai agent whose receiving address gets the test mail, such as `qa.acme@in.mails.ai`. Mail to any plus address of it, such as `qa.acme+run-1842@in.mails.ai`, reaches the same agent.
- Cypress 13 or later.

## Install

```sh
npm install --save-dev @mailsai/cypress
```

Then import it once, in your support file (`cypress/support/e2e.ts`, or `e2e.js`):

```ts
import "@mailsai/cypress";
```

That registers the four commands and adds their types to `cy`. TypeScript sees the types through this import when your tsconfig includes the support file. If it does not, add `"@mailsai/cypress"` to `compilerOptions.types` next to `"cypress"`.

## Settings

Put the settings in the `env` block of your Cypress config, read from your environment, so no key is written into the repository:

```ts
// cypress.config.ts
import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
  },
  env: {
    MAILS_API_KEY: process.env.MAILS_API_KEY,
    MAILS_RECEIVING_ADDRESS: process.env.MAILS_RECEIVING_ADDRESS,
  },
});
```

Or leave the block out and set each one as an environment variable with the `CYPRESS_` prefix, which Cypress removes:

```sh
CYPRESS_MAILS_API_KEY=mk_live_… CYPRESS_MAILS_RECEIVING_ADDRESS=qa.acme@in.mails.ai npx cypress run
```

| Setting | |
| --- | --- |
| `MAILS_API_KEY` | Required by the three wait commands. |
| `MAILS_RECEIVING_ADDRESS` | Required by `mailsaiPlusAddress`: the receiving address of the agent the test mail goes to. |
| `MAILS_BASE_URL` | Optional. `https://api.mails.ai` when unset. |
| `MAILS_AGENT_ID` | Optional. The wait commands' `agentId` when they are not given one. |

The key never appears in the Command Log, a screenshot or a video. The commands read the settings with `cy.env()`, which keeps their values in the Cypress process, and make their requests with `log: false`. Each command writes one Command Log line of its own, showing its filters. On Cypress older than 15.10, which has no `cy.env()`, the settings are read with `Cypress.env()`.

## Example

A sign-up that sends a 6-digit code:

```ts
// cypress/e2e/signup.cy.ts
describe("sign-up", () => {
  it("verifies a new account with the emailed code", () => {
    cy.mailsaiPlusAddress().then((email) => {
      cy.visit("/signup");
      cy.get("[data-cy=email]").type(email);
      cy.get("[data-cy=submit]").click();

      cy.mailsaiWaitForCode({ to: email }).then((code) => {
        cy.get("[data-cy=code]").type(code);
      });
      cy.get("[data-cy=verify]").click();

      cy.contains("Your account is verified");
    });
  });
});
```

For a sign-in link or a password reset, wait for the link and visit it:

```ts
cy.mailsaiWaitForLink({ to: email, kind: "reset_password" }).then((url) => cy.visit(url));
```

## Commands

### `cy.mailsaiPlusAddress(tag?)`

Yields a new address for this run: `MAILS_RECEIVING_ADDRESS` with `+<tag>` before the `@`. Without a tag, each call makes a new one from `run-`, the time and 4 random characters, such as `qa.acme+run-mgt2k4x1-7q3z@in.mails.ai`.

A tag is 1 to 40 letters, digits, `.`, `_`, `-` or `+`, and is lowercased. Pass a tag of your own when the address must be known in advance, such as `cy.mailsaiPlusAddress("checkout")`. Mail sent to it by an earlier run then counts too, unless the wait is given `since`.

The part of an address before the `@` holds at most 64 characters, the `+` and the tag included. When the receiving address leaves room for fewer than the 17 characters of the default tag, the default is as many random characters as fit. With room for fewer than 6, the command fails and says how much room there is, as it does for a tag of your own that is too long.

### `cy.mailsaiWaitForMessage(options?)`

Yields the newest received email that matches the options, waiting for one to arrive.

| Option | |
| --- | --- |
| `to` | Only mail sent to this address. Pass the plus address the test signed up with, so an email meant for another run is never taken. |
| `from` | Only mail from this address (`noreply@github.com`), or from this domain and its subdomains (`github.com`). |
| `has` | `"code"`: only mail with a verification code. `"link"`: only mail with a verify, sign-in or password-reset link. |
| `since` | Only mail received at or after this time (ISO 8601). Without it, the API looks back 5 minutes, so an email that arrived just before the wait began still counts. |
| `timeout` | Seconds to wait in all, 60 when not given. The command waits in calls of at most 50 seconds each until the time is used up. |
| `agentId` | Only this agent's mail. `MAILS_AGENT_ID` when not given. |

The message it yields carries `codes` and `links` (below), `subject`, `from`, `delivered_to` (the address it was sent to) and the other fields of a received message in the API reference.

When nothing arrives in time, the test fails with a message that names the filters:

```
mailsaiWaitForMessage: no email arrived within 60 s matching to: qa.acme+run-mgt2k4x1-7q3z@in.mails.ai.
```

### `cy.mailsaiWaitForCode(options?)`

Waits as `mailsaiWaitForMessage` does, for mail with a code, and yields the code: `codes[0].value`, the most likely code in the email. Takes the same options, without `has`.

### `cy.mailsaiWaitForLink(options?)`

Waits as `mailsaiWaitForMessage` does, for mail with a verify, sign-in or password-reset link, and yields a URL. Takes the same options, without `has`, and one more:

| Option | |
| --- | --- |
| `kind` | `"verify"`, `"sign_in"`, `"reset_password"` or `"other"`: yield the first link of this kind. Without it, the first `verify`, `sign_in` or `reset_password` link. |

It never yields an unsubscribe link, and fails when the email has no link it may yield. Only mail with a verify, sign-in or password-reset link is waited for, so `kind: "other"` finds a link of that kind only in such an email.

## When a call is refused

A refused call fails the test with the API's error code and message, such as:

```
mailsaiWaitForCode: mails.ai answered 401 invalid_api_key: Invalid API key (request req_…)
```

The API takes 60 waits a minute for one workspace. When it answers 429, the command pauses for as long as the answer asks and tries again, as long as what is left of its `timeout` covers the pause.

Past the plan's daily plus-address limit, a wait given `to` fails at once with 402 `plan_limit_exceeded` instead of running out its `timeout`, and its message ends with the link to change plan.

## Limits

A workspace may receive mail at a limited number of different plus addresses a day, set by its plan. Past that, mail to a new plus address keeps only a record, which a wait never yields, while the addresses already used that day keep working. The numbers for each plan are at https://mails.ai/docs/limits.

A sign-in code or link from a service such as Google, Microsoft, Apple, a payment app or a bank never reaches a plus address either: such mail keeps only a record, so a wait for it runs out its `timeout`. Unless your app is one of those services, its own emails are not affected.

## Tests

[`packages/cypress/e2e`](https://github.com/mailsai/mailsai/tree/main/packages/cypress/e2e) in the repository is a Cypress project that uses these commands the way a test suite would, against a stand-in for the mails.ai API and a small sign-up page. In `packages/cypress`, `npm run test:e2e` builds and packs the package, installs it there and runs it headless. After `npm run build`, `node --test test/*.test.mjs` runs the unit tests.

## License

MIT
