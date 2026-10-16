/// <reference types="cypress" preserve="true" />
// @mailsai/cypress: Cypress commands for testing the email an app sends at sign-up, sign-in and
// password reset. `import "@mailsai/cypress"` in the support file registers them:
//
//   cy.mailsaiPlusAddress()            a new address for this run (a plus address of one agent)
//   cy.mailsaiWaitForMessage({ to })   the email sent to it, once it arrives
//   cy.mailsaiWaitForCode({ to })      its verification code
//   cy.mailsaiWaitForLink({ to })      its verify, sign-in or password-reset link
//
// The logic is in core.ts. This file reads the settings, makes the requests and writes one Command
// Log line per command. The API key never reaches the Command Log, a screenshot or a video: the
// settings are read with cy.env() and { log: false }, and every request is made with { log: false }
// and failOnStatusCode: false, since Cypress's own error for a failed status prints the request's
// headers, the key among them.

import {
  afterAnswer,
  baseUrlOf,
  codeOf,
  CONFIG_KEYS,
  configFrom,
  describeFilters,
  linkOf,
  messageLabel,
  missingSetting,
  nextWaitSeconds,
  noCodeError,
  noLinkError,
  plusAddressFor,
  readWaitResponse,
  waitPlan,
  waitRequest,
  type MailsaiConfig,
  type MailsaiReceivedMessage,
  type MailsaiWaitForCodeOptions,
  type MailsaiWaitForLinkOptions,
  type MailsaiWaitOptions,
  type PollState,
  type WaitCommand,
  type WaitPlan,
} from "./core.js";

export type {
  LinkKind,
  MailsaiLinkKind,
  MailsaiOmittedAttachment,
  MailsaiReceivedAttachment,
  MailsaiReceivedMessage,
  MailsaiWaitForCodeOptions,
  MailsaiWaitForLinkOptions,
  MailsaiWaitOptions,
} from "./core.js";
export { MailsaiApiError } from "./core.js";

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      /**
       * A new email address for this test run: a plus address of MAILS_RECEIVING_ADDRESS, which
       * reaches the same agent. Without a tag, a new one per call (`run-<time>-<4 random>`).
       * @example cy.mailsaiPlusAddress().then((email) => cy.get("[data-cy=email]").type(email))
       */
      mailsaiPlusAddress(tag?: string): Chainable<string>;
      /**
       * The newest received email matching the filters, waiting for one to arrive for up to
       * `timeout` seconds in all (60 by default). Fails the test when none arrives.
       * @example cy.mailsaiWaitForMessage({ to: email }).its("subject").should("contain", "Welcome")
       */
      mailsaiWaitForMessage(options?: MailsaiWaitOptions): Chainable<MailsaiReceivedMessage>;
      /**
       * The verification code in the newest email with one that matches the filters, waiting for
       * it as mailsaiWaitForMessage does.
       * @example cy.mailsaiWaitForCode({ to: email }).then((code) => cy.get("[data-cy=code]").type(code))
       */
      mailsaiWaitForCode(options?: MailsaiWaitForCodeOptions): Chainable<string>;
      /**
       * The link in the newest email with a verify, sign-in or password-reset link that matches
       * the filters: the first of `kind`, or without it the first verify, sign_in or
       * reset_password link. Never an unsubscribe link.
       * @example cy.mailsaiWaitForLink({ to: email }).then((url) => cy.visit(url))
       */
      mailsaiWaitForLink(options?: MailsaiWaitForLinkOptions): Chainable<string>;
    }
  }
}

type EnvCommand = (keys: string[], options: { log: boolean }) => Cypress.Chainable<Record<string, unknown>>;

/** The settings, read so that their values never reach the Command Log: with cy.env() (Cypress
 *  15.10 and later; Cypress 16 removed Cypress.env()), else with Cypress.env(). */
function settings(): Cypress.Chainable<MailsaiConfig> {
  const keys = [...CONFIG_KEYS];
  if (typeof (cy as unknown as { env?: EnvCommand }).env === "function") {
    return cy.env(keys, { log: false }).then((env) => configFrom(env));
  }
  const legacy = Cypress as unknown as { env(key: string): unknown };
  return cy.wrap(configFrom(Object.fromEntries(keys.map((k) => [k, legacy.env(k)]))), { log: false });
}

/** Marks the command's log line failed, then fails the test with `err`. */
function fail(log: Cypress.Log, err: unknown): never {
  if (err instanceof Error) log.error(err);
  throw err;
}

/** `fn()`, with a throw marking the log line failed first. */
function attempt<T>(log: Cypress.Log, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    return fail(log, err);
  }
}

Cypress.Commands.add("mailsaiPlusAddress", (tag?: string) => {
  const log = Cypress.log({ name: "mailsaiPlusAddress", message: tag ?? "", autoEnd: false });
  return settings().then((config) => {
    const address = attempt(log, () => {
      if (!config.receivingAddress) throw missingSetting("mailsaiPlusAddress", "MAILS_RECEIVING_ADDRESS");
      return plusAddressFor(config.receivingAddress, tag);
    });
    log.set({ message: address, consoleProps: () => ({ "Receiving address": config.receivingAddress, Yielded: address }) }).end();
    return cy.wrap(address, { log: false });
  });
});

type Wait = { command: WaitCommand; plan: WaitPlan; baseUrl: string; apiKey: string; log: Cypress.Log };

/** One wait call, then what afterAnswer() says: yield, call again, pause after a 429, or fail. */
function poll(w: Wait, state: PollState): Cypress.Chainable<MailsaiReceivedMessage> {
  const seconds = nextWaitSeconds(state.left);
  const req = waitRequest(w.baseUrl, w.apiKey, w.plan, seconds);
  return cy
    .request({ method: req.method, url: req.url, headers: req.headers, timeout: req.timeout, failOnStatusCode: false, log: false })
    .then((res) => {
      const step = afterAnswer(w.command, w.plan, state, seconds, readWaitResponse(res.status, res.body, res.headers));
      switch (step.do) {
        case "yield":
          return cy.wrap(step.message, { log: false });
        case "call":
          return poll(w, step.state);
        case "pause":
          return cy.wait(step.seconds * 1000, { log: false }).then(() => poll(w, step.state));
        case "fail":
          return fail(w.log, step.error);
      }
    });
}

/** A wait command: check the options, read the settings, wait, then yield what `pick` takes from
 *  the message. */
function waitFor<T>(
  command: WaitCommand,
  options: unknown,
  pick: (message: MailsaiReceivedMessage, plan: WaitPlan) => { value: T; shown: string }
): Cypress.Chainable<T> {
  const log = Cypress.log({ name: command, message: "", autoEnd: false });
  const given = attempt(log, () => waitPlan(command, options));
  return settings().then((config) => {
    const w = attempt(log, (): Wait => {
      if (!config.apiKey) throw missingSetting(command, "MAILS_API_KEY");
      const plan = !given.agentId && config.agentId ? { ...given, agentId: config.agentId } : given;
      return { command, plan, baseUrl: baseUrlOf(config.baseUrl), apiKey: config.apiKey, log };
    });
    const filters = describeFilters(w.plan);
    const props = { Filters: filters, "Timeout (s)": w.plan.timeout, API: w.baseUrl };
    log.set({ message: `${filters}, within ${w.plan.timeout} s`, consoleProps: () => props });
    return poll(w, { left: w.plan.timeout, limited: 0 }).then((message) => {
      const { value, shown } = attempt(log, () => pick(message, w.plan));
      log.set({ message: `${filters} → ${shown}`, consoleProps: () => ({ ...props, Message: message, Yielded: value }) }).end();
      return cy.wrap(value, { log: false });
    });
  });
}

Cypress.Commands.add("mailsaiWaitForMessage", (options?: MailsaiWaitOptions) =>
  waitFor("mailsaiWaitForMessage", options, (message) => ({ value: message, shown: messageLabel(message) }))
);

Cypress.Commands.add("mailsaiWaitForCode", (options?: MailsaiWaitForCodeOptions) =>
  waitFor("mailsaiWaitForCode", options, (message) => {
    const code = codeOf(message);
    if (code === null) throw noCodeError("mailsaiWaitForCode", message);
    return { value: code, shown: code };
  })
);

Cypress.Commands.add("mailsaiWaitForLink", (options?: MailsaiWaitForLinkOptions) =>
  waitFor("mailsaiWaitForLink", options, (message, plan) => {
    const url = linkOf(message, plan.kind);
    if (url === null) throw noLinkError("mailsaiWaitForLink", message, plan.kind);
    return { value: url, shown: url };
  })
);
