// The settings, the options of mailsFixtures() and createMails(), and a wait's options, as
// @mailsai/cypress checks them (packages/cypress/test/request.test.mjs), with the methods named
// mails.waitForMessage, mails.waitForCode and mails.waitForLink.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { baseUrlOf, checkOptions, describeFilters, missingSetting, settingsFrom, waitPlan } from "../dist/core.js";

describe("settingsFrom", () => {
  const env = { MAILS_API_KEY: " mk_test_env ", MAILS_RECEIVING_ADDRESS: "env@in.mails.ai", MAILS_BASE_URL: "http://localhost:3100", MAILS_AGENT_ID: "agt_env" };

  it("reads the four settings from the environment, trimmed", () => {
    assert.deepEqual(settingsFrom({}, env), { apiKey: "mk_test_env", receivingAddress: "env@in.mails.ai", baseUrl: "http://localhost:3100", agentId: "agt_env" });
  });

  it("takes an option over its environment variable", () => {
    assert.deepEqual(settingsFrom({ apiKey: "mk_test_opt", receivingAddress: " opt@in.mails.ai ", baseUrl: "https://api.mails.ai", agentId: "agt_opt" }, env), {
      apiKey: "mk_test_opt",
      receivingAddress: "opt@in.mails.ai",
      baseUrl: "https://api.mails.ai",
      agentId: "agt_opt",
    });
  });

  it("counts an empty option as unset, as @mailsai/sdk does, and an unset variable as empty", () => {
    assert.equal(settingsFrom({ apiKey: "  " }, env).apiKey, "mk_test_env");
    assert.deepEqual(settingsFrom({}, {}), { apiKey: "", receivingAddress: "", baseUrl: "", agentId: "" });
  });
});

describe("checkOptions", () => {
  it("takes nothing, or an object of the five options", () => {
    assert.deepEqual(checkOptions("mailsFixtures", undefined), {});
    const fetch = () => {};
    assert.deepEqual(checkOptions("createMails", { apiKey: "k", receivingAddress: "a@b.co", baseUrl: "http://x", agentId: "agt", fetch }), {
      apiKey: "k",
      receivingAddress: "a@b.co",
      baseUrl: "http://x",
      agentId: "agt",
      fetch,
    });
  });

  it("refuses an option it does not have, naming the ones it has", () => {
    assert.throws(() => checkOptions("mailsFixtures", { agent: "qa" }), {
      name: "TypeError",
      message: 'mailsFixtures has no option "agent". Its options are apiKey, receivingAddress, baseUrl, agentId, fetch.',
    });
  });

  it("refuses a setting that is not a string, and never repeats the key it was given", () => {
    assert.throws(() => checkOptions("createMails", { receivingAddress: 5 }), { message: "createMails: receivingAddress must be a string. Received: 5" });
    assert.throws(() => checkOptions("createMails", { apiKey: { value: "mk_live_example" } }), (err) => {
      assert.equal(err.message, "createMails: apiKey must be a string.");
      return true;
    });
    assert.throws(() => checkOptions("createMails", { fetch: "no" }), { message: "createMails: fetch must be a function." });
    assert.throws(() => checkOptions("createMails", "qa@in.mails.ai"), { message: /takes an options object/ });
  });
});

describe("missingSetting", () => {
  it("names the setting and both ways to set it", () => {
    assert.equal(
      missingSetting("mails.waitForCode", "MAILS_API_KEY").message,
      "mails.waitForCode needs MAILS_API_KEY: a mails.ai API key with the read scope. Set the environment variable MAILS_API_KEY where the tests run, or pass apiKey to mailsFixtures() or createMails()."
    );
    assert.equal(
      missingSetting("mails.address", "MAILS_RECEIVING_ADDRESS").message,
      "mails.address needs MAILS_RECEIVING_ADDRESS: the receiving address of the mails.ai agent the test mail goes to, such as qa.acme@in.mails.ai. Set the environment variable MAILS_RECEIVING_ADDRESS where the tests run, or pass receivingAddress to mailsFixtures() or createMails()."
    );
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
  it("waits 60 seconds by default and sets has for the code and link waits", () => {
    assert.deepEqual(waitPlan("mails.waitForMessage", undefined), { timeout: 60 });
    assert.deepEqual(waitPlan("mails.waitForCode", {}), { timeout: 60, has: "code" });
    assert.deepEqual(waitPlan("mails.waitForLink", null), { timeout: 60, has: "link" });
  });

  it("keeps the filters given, trimmed", () => {
    assert.deepEqual(
      waitPlan("mails.waitForMessage", { to: " qa+run-1@in.mails.ai ", from: "github.com", has: "link", since: "2026-10-16T00:00:00Z", agentId: "agt_1", timeout: 5 }),
      { timeout: 5, to: "qa+run-1@in.mails.ai", from: "github.com", since: "2026-10-16T00:00:00Z", agentId: "agt_1", has: "link" }
    );
    assert.deepEqual(waitPlan("mails.waitForLink", { to: "a@b.co", kind: "reset_password" }), { timeout: 60, to: "a@b.co", has: "link", kind: "reset_password" });
  });

  it("takes since as a Date too, sent as its ISO 8601 form", () => {
    assert.equal(waitPlan("mails.waitForCode", { since: new Date(Date.UTC(2026, 9, 20, 9, 30)) }).since, "2026-10-20T09:30:00.000Z");
    assert.throws(() => waitPlan("mails.waitForCode", { since: new Date("nope") }), { name: "TypeError", message: "mails.waitForCode: since is a Date that is not a valid time." });
    assert.throws(() => waitPlan("mails.waitForCode", { since: 1760000000000 }), {
      message: "mails.waitForCode: since must be an ISO 8601 time, such as 2026-10-20T09:30:00Z, or a Date. Received: 1760000000000",
    });
    assert.throws(() => waitPlan("mails.waitForCode", { since: " " }), { message: "mails.waitForCode: since is empty. Give a value, or leave since out." });
  });

  it("rounds a timeout up to whole seconds and takes 0", () => {
    assert.equal(waitPlan("mails.waitForCode", { timeout: 2.5 }).timeout, 3);
    assert.equal(waitPlan("mails.waitForCode", { timeout: 0 }).timeout, 0);
    assert.equal(waitPlan("mails.waitForCode", { timeout: 600 }).timeout, 600);
  });

  it("refuses a timeout that is not a number from 0 up", () => {
    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60", null]) {
      assert.throws(() => waitPlan("mails.waitForCode", { timeout }), { name: "TypeError", message: /timeout is the seconds to wait in all/ }, String(timeout));
    }
  });

  it("refuses an empty filter rather than widening the wait to other tests' mail", () => {
    assert.throws(() => waitPlan("mails.waitForCode", { to: "" }), { message: "mails.waitForCode: to is empty. Give a value, or leave to out." });
    assert.throws(() => waitPlan("mails.waitForCode", { to: "   " }), { message: /to is empty/ });
    assert.throws(() => waitPlan("mails.waitForMessage", { from: "" }), { message: /from is empty/ });
  });

  it("refuses a filter that is not a string", () => {
    assert.throws(() => waitPlan("mails.waitForCode", { to: 5 }), { name: "TypeError", message: "mails.waitForCode: to must be a string. Received: 5" });
  });

  it("refuses an option the wait does not have, such as a misspelt to", () => {
    assert.throws(() => waitPlan("mails.waitForCode", { To: "qa@in.mails.ai" }), {
      message: 'mails.waitForCode has no option "To". Its options are to, from, since, timeout, agentId.',
    });
    assert.throws(() => waitPlan("mails.waitForCode", { has: "link" }), { message: /has no option "has"/ });
    assert.throws(() => waitPlan("mails.waitForMessage", { kind: "verify" }), { message: /has no option "kind"/ });
    assert.deepEqual(waitPlan("mails.waitForCode", { has: undefined }), { timeout: 60, has: "code" });
  });

  it("refuses a has or a kind outside the API's values", () => {
    assert.throws(() => waitPlan("mails.waitForMessage", { has: "codes" }), { message: 'mails.waitForMessage: has must be "code" or "link". Received: "codes"' });
    assert.throws(() => waitPlan("mails.waitForLink", { kind: "unsubscribe" }), { message: /kind must be one of "verify", "sign_in", "reset_password", "other"/ });
  });

  it("refuses an address given in place of the options object", () => {
    assert.throws(() => waitPlan("mails.waitForCode", "qa+run-1@in.mails.ai"), {
      message: 'mails.waitForCode takes an options object, such as { to: email }. Received: "qa+run-1@in.mails.ai"',
    });
    assert.throws(() => waitPlan("mails.waitForCode", ["a"]), { message: /takes an options object/ });
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
