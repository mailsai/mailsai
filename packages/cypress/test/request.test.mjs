// The settings, a wait command's options and the request it makes to
// GET /v1/messages/received/wait (app/api/v1/messages/received/wait/route.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { baseUrlOf, configFrom, describeFilters, missingSetting, waitPlan, waitRequest } from "../dist/core.js";

describe("configFrom", () => {
  it("reads the four settings, trimmed", () => {
    assert.deepEqual(
      configFrom({ MAILS_API_KEY: " mk_test_1 ", MAILS_RECEIVING_ADDRESS: "qa@in.mails.ai", MAILS_BASE_URL: "http://localhost:3100", MAILS_AGENT_ID: "agt_1" }),
      { apiKey: "mk_test_1", receivingAddress: "qa@in.mails.ai", baseUrl: "http://localhost:3100", agentId: "agt_1" }
    );
  });

  it("counts an unset, empty or non-string setting as unset", () => {
    assert.deepEqual(configFrom({}), { apiKey: "", receivingAddress: "", baseUrl: "", agentId: "" });
    assert.deepEqual(configFrom({ MAILS_API_KEY: "  ", MAILS_RECEIVING_ADDRESS: null, MAILS_BASE_URL: {}, MAILS_AGENT_ID: false }), {
      apiKey: "",
      receivingAddress: "",
      baseUrl: "",
      agentId: "",
    });
  });

  it("reads a number as its digits", () => {
    assert.equal(configFrom({ MAILS_AGENT_ID: 42 }).agentId, "42");
  });
});

describe("missingSetting", () => {
  it("names the setting and both ways to set it", () => {
    const err = missingSetting("mailsaiWaitForCode", "MAILS_API_KEY");
    assert.match(err.message, /^mailsaiWaitForCode needs MAILS_API_KEY: a mails\.ai API key with the read scope\./);
    assert.match(err.message, /env: \{ MAILS_API_KEY: process\.env\.MAILS_API_KEY \}/);
    assert.match(err.message, /CYPRESS_MAILS_API_KEY/);
    assert.match(missingSetting("mailsaiPlusAddress", "MAILS_RECEIVING_ADDRESS").message, /needs MAILS_RECEIVING_ADDRESS: the receiving address/);
  });
});

describe("baseUrlOf", () => {
  it("is https://api.mails.ai when unset, as in the SDK", () => {
    assert.equal(baseUrlOf(""), "https://api.mails.ai");
    assert.equal(baseUrlOf("   "), "https://api.mails.ai");
  });

  it("drops trailing slashes and spaces", () => {
    assert.equal(baseUrlOf("https://api.mails.ai///"), "https://api.mails.ai");
    assert.equal(baseUrlOf("  http://localhost:3100/ "), "http://localhost:3100");
  });

  it("refuses an address that is not http or https", () => {
    for (const raw of ["api.mails.ai", "ftp://api.mails.ai", "https://", "//api.mails.ai"]) {
      assert.throws(() => baseUrlOf(raw), { message: /^MAILS_BASE_URL must be an http:\/\/ or https:\/\/ address/ }, raw);
    }
  });
});

describe("waitPlan", () => {
  it("waits 60 seconds by default and sets has for the code and link commands", () => {
    assert.deepEqual(waitPlan("mailsaiWaitForMessage", undefined), { timeout: 60 });
    assert.deepEqual(waitPlan("mailsaiWaitForCode", {}), { timeout: 60, has: "code" });
    assert.deepEqual(waitPlan("mailsaiWaitForLink", null), { timeout: 60, has: "link" });
  });

  it("keeps the filters given, trimmed", () => {
    assert.deepEqual(
      waitPlan("mailsaiWaitForMessage", { to: " qa+run-1@in.mails.ai ", from: "github.com", has: "link", since: "2026-10-16T00:00:00Z", agentId: "agt_1", timeout: 5 }),
      { timeout: 5, to: "qa+run-1@in.mails.ai", from: "github.com", since: "2026-10-16T00:00:00Z", agentId: "agt_1", has: "link" }
    );
    assert.deepEqual(waitPlan("mailsaiWaitForLink", { to: "a@b.co", kind: "reset_password" }), { timeout: 60, to: "a@b.co", has: "link", kind: "reset_password" });
  });

  it("rounds a timeout up to whole seconds and takes 0", () => {
    assert.equal(waitPlan("mailsaiWaitForCode", { timeout: 2.5 }).timeout, 3);
    assert.equal(waitPlan("mailsaiWaitForCode", { timeout: 0 }).timeout, 0);
    assert.equal(waitPlan("mailsaiWaitForCode", { timeout: 600 }).timeout, 600);
  });

  it("refuses a timeout that is not a number from 0 up", () => {
    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60", null]) {
      assert.throws(() => waitPlan("mailsaiWaitForCode", { timeout }), { name: "TypeError", message: /timeout is the seconds to wait in all/ }, String(timeout));
    }
  });

  it("refuses an empty filter rather than widening the wait to other runs' mail", () => {
    assert.throws(() => waitPlan("mailsaiWaitForCode", { to: "" }), { message: "mailsaiWaitForCode: to is empty. Give a value, or leave to out." });
    assert.throws(() => waitPlan("mailsaiWaitForCode", { to: "   " }), { message: /to is empty/ });
    assert.throws(() => waitPlan("mailsaiWaitForMessage", { from: "" }), { message: /from is empty/ });
  });

  it("refuses a filter that is not a string", () => {
    assert.throws(() => waitPlan("mailsaiWaitForCode", { to: 5 }), { name: "TypeError", message: "mailsaiWaitForCode: to must be a string. Received: 5" });
  });

  it("refuses an option the command does not have, such as a misspelt to", () => {
    assert.throws(() => waitPlan("mailsaiWaitForCode", { To: "qa@in.mails.ai" }), {
      message: 'mailsaiWaitForCode has no option "To". Its options are to, from, since, timeout, agentId.',
    });
    assert.throws(() => waitPlan("mailsaiWaitForCode", { has: "link" }), { message: /has no option "has"/ });
    assert.throws(() => waitPlan("mailsaiWaitForMessage", { kind: "verify" }), { message: /has no option "kind"/ });
    assert.deepEqual(waitPlan("mailsaiWaitForCode", { has: undefined }), { timeout: 60, has: "code" });
  });

  it("refuses a has or a kind outside the API's values", () => {
    assert.throws(() => waitPlan("mailsaiWaitForMessage", { has: "codes" }), { message: 'mailsaiWaitForMessage: has must be "code" or "link". Received: "codes"' });
    assert.throws(() => waitPlan("mailsaiWaitForLink", { kind: "unsubscribe" }), { message: /kind must be one of "verify", "sign_in", "reset_password", "other"/ });
  });

  it("refuses an address given in place of the options object", () => {
    assert.throws(() => waitPlan("mailsaiWaitForCode", "qa+run-1@in.mails.ai"), {
      message: 'mailsaiWaitForCode takes an options object, such as { to: email }. Received: "qa+run-1@in.mails.ai"',
    });
    assert.throws(() => waitPlan("mailsaiWaitForCode", ["a"]), { message: /takes an options object/ });
  });
});

describe("describeFilters", () => {
  it("names each filter given", () => {
    assert.equal(describeFilters({ timeout: 60, to: "qa+r@in.mails.ai", has: "code" }), "to: qa+r@in.mails.ai, has: code");
    assert.equal(
      describeFilters({ timeout: 9, to: "a@b.co", from: "github.com", has: "link", kind: "verify", since: "2026-10-16T00:00:00Z", agentId: "agt_1" }),
      "to: a@b.co, from: github.com, has: link, kind: verify, since: 2026-10-16T00:00:00Z, agent: agt_1"
    );
    assert.equal(describeFilters({ timeout: 60 }), "any received mail");
  });
});

describe("waitRequest", () => {
  const plan = { timeout: 60, to: "qa.acme+run-1842@in.mails.ai", has: "code" };

  it("is a GET of /api/v1/messages/received/wait with the filters and this call's timeout", () => {
    const req = waitRequest("https://api.mails.ai", "mk_test_abc", plan, 50);
    assert.equal(req.method, "GET");
    const url = new URL(req.url);
    assert.equal(url.origin + url.pathname, "https://api.mails.ai/api/v1/messages/received/wait");
    assert.deepEqual([...url.searchParams], [
      ["to", "qa.acme+run-1842@in.mails.ai"],
      ["has", "code"],
      ["timeout", "50"],
    ]);
  });

  it("encodes the + of a plus address, so the API does not read it as a space", () => {
    const req = waitRequest("https://api.mails.ai", "k", plan, 10);
    assert.match(req.url, /to=qa\.acme%2Brun-1842%40in\.mails\.ai/);
  });

  it("sends since, from and agent_id only when given", () => {
    const bare = new URL(waitRequest("https://api.mails.ai", "k", plan, 10).url).searchParams;
    assert.equal(bare.has("since"), false);
    assert.equal(bare.has("from"), false);
    assert.equal(bare.has("agent_id"), false);
    const full = new URL(
      waitRequest("https://api.mails.ai", "k", { ...plan, from: "github.com", since: "2026-10-16T08:00:00.000Z", agentId: "agt_9" }, 10).url
    ).searchParams;
    assert.equal(full.get("from"), "github.com");
    assert.equal(full.get("since"), "2026-10-16T08:00:00.000Z");
    assert.equal(full.get("agent_id"), "agt_9");
  });

  it("authorizes with the key as a Bearer token", () => {
    const req = waitRequest("https://api.mails.ai", "mk_test_abc", plan, 50);
    assert.deepEqual(req.headers, { Authorization: "Bearer mk_test_abc", Accept: "application/json" });
  });

  it("gives the request its wait plus 15 seconds", () => {
    assert.equal(waitRequest("https://api.mails.ai", "k", plan, 50).timeout, 65_000);
    assert.equal(waitRequest("https://api.mails.ai", "k", plan, 10).timeout, 25_000);
    assert.equal(waitRequest("https://api.mails.ai", "k", plan, 0).timeout, 15_000);
  });

  it("trims the base URL and falls back to https://api.mails.ai", () => {
    assert.match(waitRequest("http://localhost:4517///", "k", plan, 1).url, /^http:\/\/localhost:4517\/api\/v1\/messages\/received\/wait\?/);
    assert.match(waitRequest("", "k", plan, 1).url, /^https:\/\/api\.mails\.ai\/api\/v1\/messages\/received\/wait\?/);
  });

  it("never puts the key in the URL", () => {
    assert.equal(waitRequest("https://api.mails.ai", "mk_test_secret", plan, 50).url.includes("mk_test_secret"), false);
  });
});
