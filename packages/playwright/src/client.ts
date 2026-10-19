// The mails object: mails.address() and the three waits, with the calls made by @mailsai/sdk
// (`received.wait`). createMails() returns one for use without the fixture; index.ts's fixture
// makes one per test and runs each wait as a step of the test.
//
// The API key is read from the options or MAILS_API_KEY when a wait needs it and is held only in
// this module's closures: it is not a property of the object, so printing the object, a step
// title, an error or a Playwright trace never shows it. The requests are made by Node's fetch, not
// by Playwright's request fixture, so no trace or report records their headers.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@mailsai/sdk";
import {
  afterAnswer,
  answerFromError,
  answerFromResult,
  baseUrlOf,
  checkOptions,
  codeOf,
  describeFilters,
  linkOf,
  missingSetting,
  nextWaitSeconds,
  noCodeError,
  noLinkError,
  plusAddressFor,
  REQUEST_GRACE_SECONDS,
  settingsFrom,
  waitPlan,
  type MailsaiReceivedMessage,
  type MailsaiWaitForCodeOptions,
  type MailsaiWaitForLinkOptions,
  type MailsaiWaitOptions,
  type MailsOptions,
  type PollState,
  type WaitAnswer,
  type WaitCommand,
  type WaitPlan,
} from "./core.js";

export type Mails = {
  /**
   * A new email address: a plus address of the receiving address (MAILS_RECEIVING_ADDRESS), which
   * reaches the same agent. Without a tag, a new one per call (`run-<time>-<4 random>`). The waits
   * that follow take mail sent to the last address it made, unless they are given `to`.
   * @example const email = mails.address(); // qa.acme+run-mgt2k4x1-7q3z@in.mails.ai
   */
  address(tag?: string): string;
  /**
   * The newest received email matching the filters, waiting for one to arrive for up to `timeout`
   * seconds in all (60 by default). Rejects when none arrives, naming the filters.
   */
  waitForMessage(options?: MailsaiWaitOptions): Promise<MailsaiReceivedMessage>;
  /** The verification code (`codes[0].value`) of the newest email with one that matches the filters. */
  waitForCode(options?: MailsaiWaitForCodeOptions): Promise<string>;
  /**
   * The link in the newest email with a verify, sign-in or password-reset link that matches the
   * filters: the first of `kind`, or without it the first verify, sign_in or reset_password link.
   * Never an unsubscribe link.
   */
  waitForLink(options?: MailsaiWaitForLinkOptions): Promise<string>;
};

/** Where a step is reported: the line in the test that called the wait. */
export type CallSite = { file: string; line: number; column: number };

/** How the fixture runs a wait: `run` as a step titled `title`, reported at `location`, with time
 *  for a wait of `seconds` added to the test's timeout. */
export type WaitHook = <T>(title: string, seconds: number, location: CallSite | undefined, run: () => Promise<T>) => Promise<T>;

const OWN_DIR = dirname(fileURLToPath(import.meta.url));

/** The first frame of `stack` outside `ownDir` and Node's own code: the line that called into
 *  this package. Undefined when there is none, as with an empty stack. */
export function callSiteFrom(stack: string | undefined, ownDir: string = OWN_DIR): CallSite | undefined {
  for (const raw of (stack ?? "").split("\n").slice(1)) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const where = line.endsWith(")") ? line.slice(line.lastIndexOf("(") + 1, -1) : line.replace(/^at (?:async )?/, "");
    const m = /^(.*):(\d+):(\d+)$/.exec(where);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (file.startsWith("node:") || file.startsWith(ownDir)) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isDeadline(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function reasonOf(err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** A mails object. `fn` names the function the options were given to, for its errors. */
export function makeMails(fn: string, input: unknown, hook?: WaitHook): Mails {
  const options = checkOptions(fn, input);
  const settings = () => settingsFrom(options, process.env);
  let lastAddress: string | undefined;

  /** One wait call asking the API to hold for `seconds`, and what its answer means. A network
   *  failure, or no answer within the wait and REQUEST_GRACE_SECONDS more, throws. */
  async function call(command: WaitCommand, plan: WaitPlan, apiKey: string, baseUrl: string, seconds: number): Promise<WaitAnswer> {
    const limitMs = (seconds + REQUEST_GRACE_SECONDS) * 1000;
    const deadline = Date.now() + limitMs;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    let status: number | null = null;
    // A client per call: its fetch gives every request it makes (the SDK retries a 5xx on its
    // own) the same deadline. maxRetryWaitSeconds 0: a 429 comes back here, and the wait pauses
    // for it out of its own timeout, as @mailsai/cypress does.
    const client = createClient({
      apiKey,
      baseUrl,
      maxRetryWaitSeconds: 0,
      fetch: async (url, init) => {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        status = res.status;
        return res;
      },
    });
    try {
      const result = await client.received.wait({
        to: plan.to,
        from: plan.from,
        has: plan.has,
        since: plan.since,
        agent_id: plan.agentId,
        timeout: seconds,
      });
      return answerFromResult(result, status ?? 200);
    } catch (err) {
      const answer = answerFromError(err, status);
      if (answer) return answer;
      if (isDeadline(err)) {
        throw new Error(`${command}: mails.ai at ${baseUrl} did not answer within ${limitMs / 1000} s (a wait of ${seconds} s for mail matching ${describeFilters(plan)}).`);
      }
      throw new Error(`${command}: could not reach mails.ai at ${baseUrl}: ${reasonOf(err)}. Is MAILS_BASE_URL the API's address?`, { cause: err });
    }
  }

  /** Calls until a message arrives, the timeout is spent, or the API refuses. */
  async function poll(command: WaitCommand, plan: WaitPlan, apiKey: string, baseUrl: string): Promise<MailsaiReceivedMessage> {
    let state: PollState = { left: plan.timeout, limited: 0 };
    for (;;) {
      const seconds = nextWaitSeconds(state.left);
      const step = afterAnswer(command, plan, state, seconds, await call(command, plan, apiKey, baseUrl, seconds));
      if (step.do === "return") return step.message;
      if (step.do === "fail") throw step.error;
      if (step.do === "pause") await sleep(step.seconds * 1000);
      state = step.state;
    }
  }

  /** A wait: check the options, read the settings, wait, then return what `pick` takes from the
   *  message. With the fixture, all of it runs as one step of the test. */
  async function waitFor<T>(
    command: WaitCommand,
    input: unknown,
    location: CallSite | undefined,
    pick: (message: MailsaiReceivedMessage, plan: WaitPlan) => T
  ): Promise<T> {
    let ready: { plan: WaitPlan; apiKey: string; baseUrl: string } | undefined;
    let refused: unknown;
    try {
      const plan = waitPlan(command, input);
      const s = settings();
      if (!s.apiKey) throw missingSetting(command, "MAILS_API_KEY");
      if (plan.to === undefined && lastAddress !== undefined) plan.to = lastAddress;
      if (plan.agentId === undefined && s.agentId) plan.agentId = s.agentId;
      ready = { plan, apiKey: s.apiKey, baseUrl: baseUrlOf(s.baseUrl) };
    } catch (err) {
      refused = err;
    }
    const run = async () => {
      if (!ready) throw refused;
      return pick(await poll(command, ready.plan, ready.apiKey, ready.baseUrl), ready.plan);
    };
    // Every promise on the way down is awaited, never just returned: Node then keeps the caller's
    // line in the stack of an error, and in the stack Playwright takes when the step begins, which
    // is where a boxed step's failure is reported.
    if (!hook) return await run();
    const title = ready ? `${command} ${describeFilters(ready.plan)}, within ${ready.plan.timeout} s` : command;
    return await hook(title, ready ? ready.plan.timeout : 0, location, run);
  }

  return {
    address(tag?: string): string {
      const s = settings();
      if (!s.receivingAddress) throw missingSetting("mails.address", "MAILS_RECEIVING_ADDRESS");
      const address = plusAddressFor(s.receivingAddress, tag);
      lastAddress = address;
      return address;
    },
    async waitForMessage(options?: MailsaiWaitOptions) {
      return await waitFor("mails.waitForMessage", options, callSiteFrom(new Error().stack), (message) => message);
    },
    async waitForCode(options?: MailsaiWaitForCodeOptions) {
      return await waitFor("mails.waitForCode", options, callSiteFrom(new Error().stack), (message) => {
        const code = codeOf(message);
        if (code === null) throw noCodeError("mails.waitForCode", message);
        return code;
      });
    },
    async waitForLink(options?: MailsaiWaitForLinkOptions) {
      return await waitFor("mails.waitForLink", options, callSiteFrom(new Error().stack), (message, plan) => {
        const url = linkOf(message, plan.kind);
        if (url === null) throw noLinkError("mails.waitForLink", message, plan.kind);
        return url;
      });
    },
  };
}

/**
 * The mails object without the fixture: for a test that does not use it, or code outside a test.
 * Each setting left out of `options` is read from its environment variable (MAILS_API_KEY,
 * MAILS_RECEIVING_ADDRESS, MAILS_BASE_URL, MAILS_AGENT_ID) when it is needed.
 * @example
 *   const mails = createMails();
 *   const email = mails.address();
 *   // …sign up with `email`…
 *   const code = await mails.waitForCode();
 */
export function createMails(options?: MailsOptions): Mails {
  return makeMails("createMails", options);
}
