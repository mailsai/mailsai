// createMails() end to end through the real @mailsai/sdk, with a scripted fetch standing in for
// GET /v1/messages/received/wait: the request each wait makes, the default `to`, and what each
// kind of answer becomes (the message, nothing in time, a 402 with its upgrade link, the 429s, an
// error body, no error body, a web page, the network, the deadline). And the API key: sent as a
// Bearer token only, and never in the object, a URL or an error. Last, the stack a wait leaves,
// in which Playwright finds the test's line to report a failure at.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { MailsError } from "@mailsai/sdk";
import { createMails, MailsaiApiError, MailsError as ExportedMailsError } from "../dist/index.js";
import { callSiteFrom, makeMails } from "../dist/client.js";

const KEY = "mk_test_unit_5ecret0123456789";
const BASE = "http://stub.test";
const RECEIVING = "qa.stub@in.mails.test";
const message = (extra = {}) => ({ id: "msg_1", agent_id: "agt_1", from: { address: "noreply@app.test" }, to: RECEIVING, received_at: "2026-10-20T08:00:00Z", subject: "Confirm your email", codes: [{ value: "482913" }], links: [{ url: "https://app.test/verify?t=1", kind: "verify" }], ...extra });

/** A fetch that answers from a script, one entry per request, and records each request. An entry
 *  is { status, body, headers } (a body that is a string goes as text/html), or a function. */
function fakeApi(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, params: Object.fromEntries(u.searchParams), headers: init.headers, signal: init.signal, at: Date.now() });
    const next = script.shift();
    if (next === undefined) throw new Error(`the script ran out at request ${calls.length}`);
    if (typeof next === "function") return next(u, init);
    const { status = 200, body = null, headers = {} } = next;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers } });
  };
  return { fetch, calls };
}

const ok = (m) => ({ body: { message: m, timed_out: false }, headers: { "x-request-id": "req_ok" } });
const nothing = { body: { message: null, timed_out: true } };
const refusal = (status, type, code, msg, extra = {}, headers = {}) => ({
  status,
  body: { error: { type, code, message: msg, param: extra.param ?? null, request_id: `req_${status}`, ...extra } },
  headers: { "x-request-id": `req_${status}`, ...headers },
});

const mailsWith = (script, options = {}) => {
  const api = fakeApi(script);
  return { api, mails: createMails({ apiKey: KEY, baseUrl: BASE, receivingAddress: RECEIVING, fetch: api.fetch, ...options }) };
};

/** The error a promise rejects with. */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the wait to fail, but it did not");
}

// No MAILS_* setting of the shell running the tests may reach them.
const saved = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("MAILS_")) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("MAILS_")) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the request", () => {
  it("is a GET of /api/v1/messages/received/wait with the filters, this call's timeout and the key as a Bearer token", async () => {
    const { api, mails } = mailsWith([ok(message())]);
    assert.equal(await mails.waitForCode({ to: "qa.stub+run-1@in.mails.test", from: "app.test", since: "2026-10-20T07:59:00Z", timeout: 20 }), "482913");
    const [call] = api.calls;
    assert.equal(call.url.origin + call.url.pathname, `${BASE}/api/v1/messages/received/wait`);
    assert.deepEqual([...call.url.searchParams], [
      ["from", "app.test"],
      ["to", "qa.stub+run-1@in.mails.test"],
      ["since", "2026-10-20T07:59:00Z"],
      ["has", "code"],
      ["timeout", "20"],
    ]);
    assert.match(call.url.search, /to=qa\.stub%2Brun-1%40in\.mails\.test/, "the + is encoded, so the API does not read it as a space");
    assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.url.href.includes(KEY), false, "the key is never in the URL");
    assert.ok(call.signal instanceof AbortSignal && !call.signal.aborted, "each request has a deadline");
  });

  it("sends a Date given as since in its ISO 8601 form, and agent_id from the agentId setting", async () => {
    const { api, mails } = mailsWith([ok(message())], { agentId: "agt_9" });
    await mails.waitForMessage({ since: new Date(Date.UTC(2026, 9, 20, 7, 59)) });
    assert.equal(api.calls[0].params.since, "2026-10-20T07:59:00.000Z");
    assert.equal(api.calls[0].params.agent_id, "agt_9");
    const other = mailsWith([ok(message())], { agentId: "agt_9" });
    await other.mails.waitForMessage({ agentId: "agt_given" });
    assert.equal(other.api.calls[0].params.agent_id, "agt_given");
  });

  it("waits for mail to the last address mails.address() made, unless given `to`", async () => {
    const { api, mails } = mailsWith([ok(message()), ok(message()), ok(message()), ok(message())]);
    await mails.waitForMessage();
    assert.equal(api.calls[0].params.to, undefined, "no address made yet: any received mail, as @mailsai/cypress without `to`");
    const first = mails.address();
    await mails.waitForCode();
    assert.equal(api.calls[1].params.to, first);
    const second = mails.address("second");
    assert.equal(second, "qa.stub+second@in.mails.test");
    await mails.waitForLink();
    assert.equal(api.calls[2].params.to, second);
    await mails.waitForCode({ to: first });
    assert.equal(api.calls[3].params.to, first);
  });

  it("reads each setting from its environment variable when it is not given", async () => {
    const api = fakeApi([ok(message())]);
    process.env.MAILS_API_KEY = KEY;
    process.env.MAILS_RECEIVING_ADDRESS = "env.agent@in.mails.test";
    process.env.MAILS_BASE_URL = `${BASE}/`;
    process.env.MAILS_AGENT_ID = "agt_env";
    const mails = createMails({ fetch: api.fetch });
    assert.match(mails.address(), /^env\.agent\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
    await mails.waitForCode();
    assert.equal(api.calls[0].url.origin, BASE);
    assert.equal(api.calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(api.calls[0].params.agent_id, "agt_env");
  });

  it("makes no request when a setting is missing or an option is wrong, and says which", async () => {
    const api = fakeApi([]);
    const keyless = createMails({ receivingAddress: RECEIVING, fetch: api.fetch });
    assert.equal(keyless.address("nokey"), "qa.stub+nokey@in.mails.test", "an address needs no key");
    assert.equal((await rejection(keyless.waitForCode())).message.split(":")[0], "mails.waitForCode needs MAILS_API_KEY");
    assert.throws(() => createMails({ apiKey: KEY, fetch: api.fetch }).address(), { message: /^mails\.address needs MAILS_RECEIVING_ADDRESS: / });
    assert.equal((await rejection(createMails({ apiKey: KEY, baseUrl: "api.mails.ai", fetch: api.fetch }).waitForCode())).message.slice(0, 54), "MAILS_BASE_URL must be an http:// or https:// address,");
    const { mails } = mailsWith([]);
    assert.equal((await rejection(mails.waitForLink({ To: "x@y.z" }))).message, 'mails.waitForLink has no option "To". Its options are to, from, since, timeout, agentId, kind.');
    assert.equal((await rejection(mails.waitForCode({ to: "" }))).message, "mails.waitForCode: to is empty. Give a value, or leave to out.");
    assert.equal(api.calls.length, 0);
  });
});

describe("the answers", () => {
  it("calls again after nothing arrived, with what is left of the timeout", async () => {
    const { api, mails } = mailsWith([nothing, ok(message())]);
    // A 0.4 s timeout rounds up to 1: one call of 1 s, then nothing is left.
    assert.equal((await rejection(mailsWith([nothing]).mails.waitForCode({ to: "a@b.co", timeout: 0.4 }))).message, "mails.waitForCode: no email arrived within 1 s matching to: a@b.co, has: code.");
    await mails.waitForCode({ timeout: 60 });
    assert.deepEqual(api.calls.map((c) => c.params.timeout), ["50", "10"]);
  });

  it("fails at once on a 402, with the link to change plan, as a MailsError of @mailsai/sdk", async () => {
    const to = "qa.stub+planlimit-1@in.mails.test";
    const text = `Mail to ${to} arrived but was not kept: your plan keeps mail sent to 20 different plus addresses a day, and ${to} would have been one more. Upgrade, or reuse a plus address that already received mail today.`;
    const { api, mails } = mailsWith([refusal(402, "payment_error", "plan_limit_exceeded", text, { param: "to", upgrade_url: "https://app.mails.ai/billing" }), ok(message())]);
    const started = Date.now();
    const err = await rejection(mails.waitForCode({ to }));
    assert.ok(Date.now() - started < 1000, "at once");
    assert.equal(api.calls.length, 1, "one call, no retry");
    assert.ok(err instanceof MailsaiApiError && err instanceof MailsError);
    assert.equal(err.message, `mails.waitForCode: mails.ai answered 402 plan_limit_exceeded: ${text} Change your plan: https://app.mails.ai/billing (request req_402)`);
    assert.deepEqual([err.status, err.code, err.type, err.param, err.requestId, err.upgradeUrl], [402, "plan_limit_exceeded", "payment_error", "to", "req_402", "https://app.mails.ai/billing"]);
  });

  it("fails at once on any other refusal, with the API's code and message", async () => {
    const { api, mails } = mailsWith([refusal(401, "authentication_error", "invalid_api_key", "Invalid API key")]);
    assert.equal((await rejection(mails.waitForCode({ to: "a@b.co" }))).message, "mails.waitForCode: mails.ai answered 401 invalid_api_key: Invalid API key (request req_401)");
    assert.equal(api.calls.length, 1);
  });

  it("waits out a 429 that says how long, out of the same timeout", async () => {
    const limited = refusal(429, "rate_limit_error", "rate_limit_exceeded", "At most 60 waits a minute for one workspace.", { resets_at: new Date(Date.now() + 1000).toISOString(), retry_after_seconds: 1 }, { "retry-after": "1" });
    const { api, mails } = mailsWith([limited, ok(message())]);
    assert.equal(await mails.waitForCode({ to: "a@b.co", timeout: 10 }), "482913");
    assert.deepEqual(api.calls.map((c) => c.params.timeout), ["10", "9"], "the 1 s pause came out of the 10 s timeout");
    assert.ok(api.calls[1].at - api.calls[0].at >= 950, "it paused about a second");
  });

  it("fails at once on a 429 longer than what is left, in its own words, not the SDK's", async () => {
    const limited = refusal(429, "rate_limit_error", "rate_limit_exceeded", "At most 60 waits a minute for one workspace.", { resets_at: new Date(Date.now() + 30_000).toISOString(), retry_after_seconds: 30 }, { "retry-after": "30" });
    const { api, mails } = mailsWith([limited]);
    const err = await rejection(mails.waitForCode({ to: "a@b.co", timeout: 10 }));
    assert.equal(
      err.message,
      "mails.waitForCode: mails.ai answered 429 rate_limit_exceeded: At most 60 waits a minute for one workspace. Waiting for it takes 30 s, more than the 10 s left of this wait's 10 s timeout. (request req_429)"
    );
    assert.equal(api.calls.length, 1);
  });

  it("fails at once on a 429 that no wait lifts (resets_at null)", async () => {
    const { mails } = mailsWith([refusal(429, "rate_limit_error", "daily_limit_exceeded", "Daily limit reached.", { resets_at: null, retry_after_seconds: null })]);
    assert.equal((await rejection(mails.waitForCode({ to: "a@b.co" }))).message, "mails.waitForCode: mails.ai answered 429 daily_limit_exceeded: Daily limit reached. Waiting does not lift this limit. (request req_429)");
  });

  it("says an answer without a mails.ai error body came from the wrong place, after the SDK's own retries of a 5xx", async () => {
    const page = { status: 502, body: "<html>Bad gateway</html>" };
    const { api, mails } = mailsWith([page, page, page, page]);
    assert.equal((await rejection(mails.waitForCode({ to: "a@b.co" }))).message, "mails.waitForCode: mails.ai answered 502 unknown: The API answered 502 without a mails.ai error body. Is MAILS_BASE_URL the API's address?");
    assert.equal(api.calls.length, 4, "@mailsai/sdk tries a GET 3 more times on a 5xx");
    const notFound = mailsWith([{ status: 404, body: "<html>Not found</html>" }]);
    assert.match((await rejection(notFound.mails.waitForCode({ to: "a@b.co" }))).message, /answered 404 unknown: The API answered 404 without a mails\.ai error body/);
  });

  it("says a 200 that is not a wait result came from the wrong place", async () => {
    const html = mailsWith([{ status: 200, body: "<!doctype html><title>mails.ai</title>" }]);
    assert.equal(
      (await rejection(html.mails.waitForCode({ to: "a@b.co" }))).message,
      "mails.waitForCode: mails.ai answered 200 unexpected_response: The answer was not a mails.ai wait result ({ message, timed_out }). Is MAILS_BASE_URL the API's address?"
    );
    const json = mailsWith([{ status: 200, body: { ok: true } }]);
    assert.match((await rejection(json.mails.waitForCode({ to: "a@b.co" }))).message, /unexpected_response/);
  });

  it("names the address it could not reach, and the reason", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) }));
    const { mails } = mailsWith([down]);
    const err = await rejection(mails.waitForCode({ to: "a@b.co" }));
    assert.equal(err.message, `mails.waitForCode: could not reach mails.ai at ${BASE}: connect ECONNREFUSED 127.0.0.1:9. Is MAILS_BASE_URL the API's address?`);
    assert.ok(err.cause instanceof TypeError);
  });

  it("fails when a request does not answer by its deadline: the wait and 15 seconds", async () => {
    const hang = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const { mails } = mailsWith([hang]);
    assert.equal(
      (await rejection(mails.waitForCode({ to: "a@b.co", timeout: 0 }))).message,
      `mails.waitForCode: mails.ai at ${BASE} did not answer within 15 s (a wait of 0 s for mail matching to: a@b.co, has: code).`
    );
  });

  it("fails when the email has no code, or no link it may return", async () => {
    const noCode = mailsWith([ok(message({ codes: [] }))]);
    assert.equal((await rejection(noCode.mails.waitForCode({ to: "a@b.co" }))).message, 'mails.waitForCode: the email msg_1 ("Confirm your email") has no code.');
    const onlyUnsubscribe = mailsWith([ok(message({ links: [{ url: "https://app.test/u", kind: "unsubscribe" }] }))]);
    assert.equal(
      (await rejection(onlyUnsubscribe.mails.waitForLink({ to: "a@b.co" }))).message,
      'mails.waitForLink: the email msg_1 ("Confirm your email") has no verify, sign_in or reset_password link. Its links: unsubscribe (1).'
    );
  });
});

describe("the API key", () => {
  it("is not in the object, however it is printed", () => {
    const { mails } = mailsWith([]);
    for (const shown of [inspect(mails, { showHidden: true, depth: Infinity, getters: true }), JSON.stringify(mails), String(Object.entries(mails))]) {
      assert.equal(shown.includes(KEY), false, shown);
    }
  });

  it("is in no error, whatever went wrong", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND stub.test") }));
    const errors = [
      await rejection(mailsWith([refusal(401, "authentication_error", "invalid_api_key", "Invalid API key")]).mails.waitForCode()),
      await rejection(mailsWith([refusal(402, "payment_error", "plan_limit_exceeded", "Upgrade.", { upgrade_url: "https://app.mails.ai/billing" })]).mails.waitForCode()),
      await rejection(mailsWith([{ status: 500, body: "oops" }, { status: 500, body: "oops" }, { status: 500, body: "oops" }, { status: 500, body: "oops" }]).mails.waitForCode()),
      await rejection(mailsWith([down]).mails.waitForCode()),
      await rejection(mailsWith([nothing]).mails.waitForCode({ timeout: 0 })),
    ];
    for (const err of errors) {
      const shown = inspect(err, { depth: Infinity, showHidden: true });
      assert.equal(shown.includes(KEY), false, shown);
      assert.equal(/bearer/i.test(shown), false, shown);
    }
  });
});

describe("callSiteFrom", () => {
  const own = "/work/node_modules/@mailsai/playwright/dist";

  it("is the first frame outside this package and Node, in each frame format", () => {
    const stack = [
      "Error",
      `    at Object.waitForCode (${own}/client.js:120:54)`,
      "    at /work/tests/signup.spec.ts:14:31",
      "    at async Promise.all (index 0)",
    ].join("\n");
    assert.deepEqual(callSiteFrom(stack, own), { file: "/work/tests/signup.spec.ts", line: 14, column: 31 });
    assert.deepEqual(callSiteFrom(`Error\n    at file://${own}/client.js:1:1\n    at signUp (file:///work/tests/esm%20dir/a.spec.ts:7:3)`, own), {
      file: "/work/tests/esm dir/a.spec.ts",
      line: 7,
      column: 3,
    });
    assert.deepEqual(callSiteFrom(`Error\n    at x (node:internal/process/task_queues:95:5)\n    at async helper (/work/helpers.ts:3:9)`, own), { file: "/work/helpers.ts", line: 3, column: 9 });
  });

  it("is undefined when no frame is outside", () => {
    assert.equal(callSiteFrom(undefined, own), undefined);
    assert.equal(callSiteFrom(`Error\n    at f (${own}/client.js:1:1)\n    at <anonymous>`, own), undefined);
  });
});

describe("the package's exports", () => {
  it("export the SDK's MailsError itself, the class a MailsaiApiError is an instance of", () => {
    assert.equal(ExportedMailsError, MailsError);
  });
});

describe("the stack of a wait", () => {
  // Playwright reports a boxed step's failure at the first line outside the package in the stack it
  // takes as the step begins, after an await of its own. That stack reaches the test's line only
  // when every function between them awaits the next one's promise (Node's async stack traces).
  const hooked = (seen) =>
    makeMails("mailsFixtures", { apiKey: KEY, baseUrl: BASE, receivingAddress: RECEIVING, fetch: fakeApi([ok(message())]).fetch }, async (title, seconds, location, run) => {
      await null;
      seen.stack = new Error().stack;
      seen.title = title;
      seen.location = location;
      return await run();
    });

  it("still reaches the caller's line after an await in the hook, and the hook is given that line", async () => {
    const seen = {};
    const mails = hooked(seen);
    async function theLineOfTheTest() {
      return await mails.waitForCode({ to: "qa.stub+run-1@in.mails.test" });
    }
    assert.equal(await theLineOfTheTest(), "482913");
    assert.match(seen.stack, /\n\s+at async theLineOfTheTest \(/);
    assert.equal(seen.title, "mails.waitForCode to: qa.stub+run-1@in.mails.test, has: code, within 60 s");
    assert.equal(seen.location.file, fileURLToPath(import.meta.url));
  });

  it("of an error without the fixture also reaches the caller's line", async () => {
    const { mails } = mailsWith([nothing]);
    async function theLineOfTheTest() {
      return await mails.waitForCode({ to: "qa.stub+run-1@in.mails.test", timeout: 0 });
    }
    const err = await rejection(theLineOfTheTest());
    assert.equal(err.message, "mails.waitForCode: no email arrived within 0 s matching to: qa.stub+run-1@in.mails.test, has: code.");
    assert.match(err.stack, /\n\s+at async theLineOfTheTest \(/);
  });
});
