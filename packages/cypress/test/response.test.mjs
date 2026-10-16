// Reading a wait call's answer: the message, nothing in time, the API's error body (lib/errors.ts
// toResponse) and its 429s, with how long to pause before trying again.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MailsaiApiError, noMailError, parseRetryAfter, rateLimitError, readWaitResponse, retryPause } from "../dist/core.js";

const message = { id: "msg_1", agent_id: "agt_1", from: { address: "noreply@app.test" }, to: "qa@in.mails.ai", received_at: "2026-10-16T08:00:00Z", codes: [{ value: "123456" }] };

describe("readWaitResponse", () => {
  it("is the message when one arrived", () => {
    assert.deepEqual(readWaitResponse(200, { message, timed_out: false }), { kind: "message", message });
  });

  it("is timed_out when nothing arrived in time", () => {
    assert.deepEqual(readWaitResponse(200, { message: null, timed_out: true }), { kind: "timed_out" });
  });

  it("reads a JSON body cy.request left as text", () => {
    assert.deepEqual(readWaitResponse(200, JSON.stringify({ message, timed_out: false })), { kind: "message", message });
  });

  it("is an error when a 200 is not a wait result, such as a web page at a wrong MAILS_BASE_URL", () => {
    const answer = readWaitResponse(200, "<!doctype html><title>mails.ai</title>");
    assert.equal(answer.kind, "error");
    assert.equal(answer.error.code, "unexpected_response");
    assert.match(answer.error.message, /Is MAILS_BASE_URL the API's address\?/);
    assert.equal(readWaitResponse(200, { ok: true }).kind, "error");
  });

  it("carries the API's error type, code, message, param and request id", () => {
    const body = { error: { type: "invalid_request_error", code: "invalid_param_value", message: "to must be the email address the mail was sent to.", param: "to", request_id: "req_7" } };
    assert.deepEqual(readWaitResponse(400, body), {
      kind: "error",
      error: {
        status: 400,
        type: "invalid_request_error",
        code: "invalid_param_value",
        message: "to must be the email address the mail was sent to.",
        param: "to",
        requestId: "req_7",
        upgradeUrl: null,
      },
    });
    const denied = readWaitResponse(401, { error: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key", param: null, request_id: "req_8" } });
    assert.equal(denied.kind, "error");
    assert.equal(denied.error.code, "invalid_api_key");
    assert.equal(denied.error.param, null);
  });

  it("takes the request id from X-Request-Id when the body has none", () => {
    const answer = readWaitResponse(500, "Internal Server Error", { "x-request-id": "req_9" });
    assert.equal(answer.kind, "error");
    assert.deepEqual(answer.error, {
      status: 500,
      type: "api_error",
      code: "unknown",
      message: "The API answered 500 without a mails.ai error body. Is MAILS_BASE_URL the API's address?",
      param: null,
      requestId: "req_9",
      upgradeUrl: null,
    });
  });

  it("carries the upgrade_url of a 402, and only a string one", () => {
    const body = (upgrade_url) => ({ error: { type: "payment_error", code: "plan_limit_exceeded", message: "Upgrade.", param: "to", request_id: "req_1", upgrade_url } });
    const answer = readWaitResponse(402, body("https://app.mails.ai/billing"));
    assert.equal(answer.kind, "error");
    assert.equal(answer.error.upgradeUrl, "https://app.mails.ai/billing");
    assert.equal(readWaitResponse(402, body(undefined)).error.upgradeUrl, null);
    assert.equal(readWaitResponse(402, body(42)).error.upgradeUrl, null);
  });

  it("reads a 429's wait from Retry-After first, then the body's retry_after_seconds", () => {
    const body = { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "At most 60 waits a minute for one workspace.", resets_at: "2026-10-16T08:00:30.000Z", retry_after_seconds: 30 } };
    const both = readWaitResponse(429, body, { "retry-after": "12" });
    assert.equal(both.kind, "rate_limited");
    assert.equal(both.retryAfterSeconds, 12);
    assert.equal(both.waitHelps, true);
    assert.equal(both.error.code, "rate_limit_exceeded");
    assert.equal(readWaitResponse(429, body).retryAfterSeconds, 30);
    assert.equal(readWaitResponse(429, body, { "Retry-After": ["7"] }).retryAfterSeconds, 7);
  });

  it("knows a 429 that no wait lifts: resets_at null", () => {
    const answer = readWaitResponse(429, { error: { type: "rate_limit_error", code: "daily_limit_exceeded", message: "Daily limit reached.", resets_at: null, retry_after_seconds: null } });
    assert.equal(answer.kind, "rate_limited");
    assert.equal(answer.waitHelps, false);
    assert.equal(answer.retryAfterSeconds, null);
  });

  it("reads a 429 with no body as one that waiting may lift, for an unknown time", () => {
    const answer = readWaitResponse(429, "");
    assert.equal(answer.kind, "rate_limited");
    assert.equal(answer.retryAfterSeconds, null);
    assert.equal(answer.waitHelps, true);
    assert.equal(answer.error.type, "rate_limit_error");
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds or an HTTP date", () => {
    assert.equal(parseRetryAfter("5"), 5);
    assert.equal(parseRetryAfter("0"), 0);
    const now = Date.UTC(2026, 9, 16, 8, 0, 0);
    assert.equal(parseRetryAfter(new Date(now + 20_000).toUTCString(), now), 20);
  });

  it("is null when absent or unreadable", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(""), null);
    assert.equal(parseRetryAfter("soon"), null);
  });
});

describe("retryPause", () => {
  it("pauses as long as the answer asks, in whole seconds, at least 1", () => {
    assert.equal(retryPause({ retryAfterSeconds: 12, waitHelps: true }, 0), 12);
    assert.equal(retryPause({ retryAfterSeconds: 0.2, waitHelps: true }, 0), 1);
    assert.equal(retryPause({ retryAfterSeconds: 2.1, waitHelps: true }, 0), 3);
  });

  it("caps the pause at 60 seconds", () => {
    assert.equal(retryPause({ retryAfterSeconds: 3600, waitHelps: true }, 0), 60);
  });

  it("backs off 1, 2, 4, then 8 seconds when the answer does not say", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map((times) => retryPause({ retryAfterSeconds: null, waitHelps: true }, times)), [1, 2, 4, 8, 8, 8]);
  });

  it("is null when no wait lifts the limit", () => {
    assert.equal(retryPause({ retryAfterSeconds: 30, waitHelps: false }, 0), null);
  });
});

describe("the errors", () => {
  const details = { status: 401, type: "authentication_error", code: "invalid_api_key", message: "Invalid API key", param: null, requestId: "req_8" };

  it("MailsaiApiError carries the API's code and message", () => {
    const err = new MailsaiApiError("mailsaiWaitForCode", details);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "MailsaiApiError");
    assert.equal(err.message, "mailsaiWaitForCode: mails.ai answered 401 invalid_api_key: Invalid API key (request req_8)");
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_api_key");
    assert.equal(err.type, "authentication_error");
    assert.equal(err.requestId, "req_8");
    assert.equal(new MailsaiApiError("x", { ...details, requestId: null }).message, "x: mails.ai answered 401 invalid_api_key: Invalid API key");
    assert.equal(err.upgradeUrl, null);
  });

  it("MailsaiApiError ends with the link to change plan when the answer has one, before the request id", () => {
    const paid = { status: 402, type: "payment_error", code: "plan_limit_exceeded", message: "Upgrade.", param: "to", requestId: "req_5", upgradeUrl: "https://app.mails.ai/billing" };
    const err = new MailsaiApiError("mailsaiWaitForLink", paid);
    assert.equal(err.message, "mailsaiWaitForLink: mails.ai answered 402 plan_limit_exceeded: Upgrade. Change your plan: https://app.mails.ai/billing (request req_5)");
    assert.equal(err.upgradeUrl, "https://app.mails.ai/billing");
    assert.equal(new MailsaiApiError("x", { ...paid, requestId: null }).message, "x: mails.ai answered 402 plan_limit_exceeded: Upgrade. Change your plan: https://app.mails.ai/billing");
  });

  it("a 429 the timeout cannot wait out says so", () => {
    const limited = { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", message: "At most 60 waits a minute for one workspace.", param: null, requestId: null };
    assert.equal(
      rateLimitError("mailsaiWaitForLink", limited, 30, 5, 60).message,
      "mailsaiWaitForLink: mails.ai answered 429 rate_limit_exceeded: At most 60 waits a minute for one workspace. Waiting for it takes 30 s, more than the 5 s left of this command's 60 s timeout."
    );
    assert.match(rateLimitError("mailsaiWaitForLink", limited, null, 50, 60).message, /Waiting does not lift this limit\.$/);
  });

  it("nothing in time names the timeout and the filters", () => {
    assert.equal(
      noMailError("mailsaiWaitForCode", { timeout: 60, to: "qa+run-1@in.mails.ai", has: "code" }).message,
      "mailsaiWaitForCode: no email arrived within 60 s matching to: qa+run-1@in.mails.ai, has: code."
    );
  });
});
