// Spending a wait's timeout as wait calls of at most 50 seconds, with the pauses a 429 asks for:
// the decisions client.ts's poll() carries out, driven here by scripted answers, as
// @mailsai/cypress drives its own (packages/cypress/test/budget.test.mjs).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MailsError } from "@mailsai/sdk";
import { afterAnswer, MailsaiApiError, nextWaitSeconds, splitTimeout } from "../dist/core.js";

const message = { id: "msg_1", agent_id: "agt_1", from: { address: "noreply@app.test" }, to: "qa@in.mails.ai", received_at: "2026-10-16T08:00:00Z" };
const TIMED_OUT = { kind: "timed_out" };
const limited = (retryAfterSeconds, waitHelps = true) => ({
  kind: "rate_limited",
  retryAfterSeconds,
  waitHelps,
  error: { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", message: "At most 60 waits a minute for one workspace.", param: null, requestId: null, upgradeUrl: null },
});

/** What poll() would do for a timeout and a script of answers: the seconds each call asked to
 *  hold, the pauses, and how it ended. */
function run(timeout, answers) {
  const plan = { timeout, to: "qa+run-1@in.mails.ai", has: "code" };
  const calls = [];
  const pauses = [];
  let state = { left: timeout, limited: 0 };
  for (const answer of answers) {
    const seconds = nextWaitSeconds(state.left);
    calls.push(seconds);
    const step = afterAnswer("mails.waitForCode", plan, state, seconds, answer);
    if (step.do === "return") return { calls, pauses, returned: step.message };
    if (step.do === "fail") return { calls, pauses, error: step.error.message, failure: step.error };
    if (step.do === "pause") pauses.push(step.seconds);
    state = step.state;
  }
  throw new Error(`the script ran out after ${calls.length} calls`);
}

describe("splitTimeout", () => {
  it("spends a timeout as waits of at most 50 seconds", () => {
    assert.deepEqual(splitTimeout(60), [50, 10]);
    assert.deepEqual(splitTimeout(50), [50]);
    assert.deepEqual(splitTimeout(51), [50, 1]);
    assert.deepEqual(splitTimeout(100), [50, 50]);
    assert.deepEqual(splitTimeout(120), [50, 50, 20]);
    assert.deepEqual(splitTimeout(7), [7]);
  });

  it("makes one immediate look for a timeout of 0", () => {
    assert.deepEqual(splitTimeout(0), [0]);
  });
});

describe("nextWaitSeconds", () => {
  it("is what is left, at most 50, never below 0", () => {
    assert.equal(nextWaitSeconds(60), 50);
    assert.equal(nextWaitSeconds(10), 10);
    assert.equal(nextWaitSeconds(0), 0);
    assert.equal(nextWaitSeconds(-3), 0);
  });
});

describe("afterAnswer", () => {
  it("returns the message as soon as one arrives", () => {
    assert.deepEqual(run(60, [{ kind: "message", message }]), { calls: [50], pauses: [], returned: message });
  });

  it("calls again with the rest after nothing arrived: 60 s is 50 + 10", () => {
    assert.deepEqual(run(60, [TIMED_OUT, { kind: "message", message }]), { calls: [50, 10], pauses: [], returned: message });
  });

  it("fails naming the filters once the whole timeout passed with nothing", () => {
    const out = run(60, [TIMED_OUT, TIMED_OUT, TIMED_OUT]);
    assert.deepEqual(out.calls, [50, 10]);
    assert.equal(out.error, "mails.waitForCode: no email arrived within 60 s matching to: qa+run-1@in.mails.ai, has: code.");
    assert.deepEqual(run(120, [TIMED_OUT, TIMED_OUT, TIMED_OUT, TIMED_OUT]).calls, [50, 50, 20]);
    assert.deepEqual(run(0, [TIMED_OUT, TIMED_OUT]).calls, [0]);
  });

  it("pauses as a 429 asks, out of the same timeout, then calls again", () => {
    assert.deepEqual(run(60, [limited(12), { kind: "message", message }]), { calls: [50, 48], pauses: [12], returned: message });
    // The 12 s pause and the 48 s call that follows are the whole 60 s.
    const out = run(60, [limited(12), TIMED_OUT, { kind: "message", message }]);
    assert.deepEqual(out.calls, [50, 48]);
    assert.match(out.error, /no email arrived within 60 s/);
  });

  it("backs off 1, 2, 4 seconds over 429s in a row that do not say how long", () => {
    const out = run(60, [limited(null), limited(null), limited(null), { kind: "message", message }]);
    assert.deepEqual(out.pauses, [1, 2, 4]);
    assert.deepEqual(out.calls, [50, 50, 50, 50]);
  });

  it("starts the back-off again after a call that was not refused", () => {
    const out = run(120, [limited(null), limited(null), TIMED_OUT, limited(null), { kind: "message", message }]);
    assert.deepEqual(out.pauses, [1, 2, 1]);
  });

  it("fails at once when the pause is longer than what is left of the timeout", () => {
    const out = run(10, [limited(30)]);
    assert.deepEqual(out.calls, [10]);
    assert.match(out.error, /429 rate_limit_exceeded: At most 60 waits a minute for one workspace\. Waiting for it takes 30 s, more than the 10 s left of this wait's 10 s timeout\.$/);
  });

  it("still makes a last immediate look when the pause uses up exactly what is left", () => {
    assert.deepEqual(run(5, [limited(5), { kind: "message", message }]), { calls: [5, 0], pauses: [5], returned: message });
  });

  it("fails at once on a 429 that no wait lifts", () => {
    assert.match(run(60, [limited(null, false)]).error, /Waiting does not lift this limit\.$/);
  });

  it("fails on the first call, with the link to change plan, when the plan's daily plus-address limit refused the mail", () => {
    const to = "qa.acme+run-1843@in.mails.ai";
    const text = `Mail to ${to} arrived but was not kept: your plan keeps mail sent to 20 different plus addresses a day, and ${to} would have been one more. Upgrade, or reuse a plus address that already received mail today.`;
    const answer = {
      kind: "error",
      error: { status: 402, type: "payment_error", code: "plan_limit_exceeded", message: text, param: "to", requestId: "req_402", upgradeUrl: "https://app.mails.ai/billing" },
    };
    const out = run(60, [answer, { kind: "message", message: { id: "msg_never" } }]);
    assert.deepEqual(out.calls, [50], "one call, no retry");
    assert.deepEqual(out.pauses, [], "no pause");
    assert.ok(out.failure instanceof MailsaiApiError);
    assert.ok(out.failure instanceof MailsError, "a MailsError of @mailsai/sdk");
    assert.equal(out.failure.name, "MailsaiApiError");
    assert.equal(out.failure.status, 402);
    assert.equal(out.failure.code, "plan_limit_exceeded");
    assert.equal(out.failure.param, "to");
    assert.equal(out.failure.requestId, "req_402");
    assert.equal(out.failure.upgradeUrl, "https://app.mails.ai/billing");
    assert.equal(out.error, `mails.waitForCode: mails.ai answered 402 plan_limit_exceeded: ${text} Change your plan: https://app.mails.ai/billing (request req_402)`);
  });

  it("fails at once on any other error, with the API's code and message", () => {
    const out = run(60, [{ kind: "error", error: { status: 403, type: "permission_error", code: "insufficient_scope", message: "This key lacks the read scope.", param: null, requestId: "req_3", upgradeUrl: null } }]);
    assert.deepEqual(out.calls, [50]);
    assert.equal(out.error, "mails.waitForCode: mails.ai answered 403 insufficient_scope: This key lacks the read scope. (request req_3)");
    assert.equal(out.failure.upgradeUrl, undefined);
  });
});
