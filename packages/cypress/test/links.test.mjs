// What mailsaiWaitForCode and mailsaiWaitForLink yield from the message, and how they fail when it
// has nothing to yield. Kinds as lib/codes-and-links.ts names them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeOf, linkOf, messageLabel, noCodeError, noLinkError } from "../dist/core.js";

const base = { id: "msg_1", agent_id: "agt_1", from: { address: "noreply@app.test" }, to: "qa@in.mails.ai", received_at: "2026-10-16T08:00:00Z", subject: "Confirm your email" };
const withLinks = (links) => ({ ...base, links });

describe("codeOf", () => {
  it("is the first code, the most likely one", () => {
    assert.equal(codeOf({ ...base, codes: [{ value: "482913" }, { value: "2026" }] }), "482913");
  });

  it("is null when there is none", () => {
    assert.equal(codeOf(base), null);
    assert.equal(codeOf({ ...base, codes: [] }), null);
    assert.equal(codeOf({ ...base, codes: [{ value: "" }] }), null);
  });
});

describe("linkOf", () => {
  const links = [
    { url: "https://app.test/unsubscribe?u=1", kind: "unsubscribe" },
    { url: "https://app.test/help", kind: "other" },
    { url: "https://app.test/reset?t=9", kind: "reset_password" },
    { url: "https://app.test/verify?t=1", kind: "verify" },
    { url: "https://app.test/login?t=2", kind: "sign_in" },
  ];

  it("is the first verify, sign_in or reset_password link when no kind is asked for", () => {
    assert.equal(linkOf(withLinks(links)), "https://app.test/reset?t=9");
    assert.equal(linkOf(withLinks(links.filter((l) => l.kind !== "reset_password"))), "https://app.test/verify?t=1");
  });

  it("is the first link of the kind asked for", () => {
    assert.equal(linkOf(withLinks(links), "verify"), "https://app.test/verify?t=1");
    assert.equal(linkOf(withLinks(links), "sign_in"), "https://app.test/login?t=2");
    assert.equal(linkOf(withLinks(links), "other"), "https://app.test/help");
  });

  it("never yields an unsubscribe link", () => {
    const onlyUnsubscribe = withLinks([{ url: "https://app.test/unsubscribe?u=1", kind: "unsubscribe" }]);
    assert.equal(linkOf(onlyUnsubscribe), null);
    assert.equal(linkOf(onlyUnsubscribe, "unsubscribe"), null);
  });

  it("is null when no link fits", () => {
    assert.equal(linkOf(withLinks([{ url: "https://app.test/help", kind: "other" }])), null);
    assert.equal(linkOf(withLinks(links), "verify") !== null, true);
    assert.equal(linkOf(base), null);
    assert.equal(linkOf(withLinks([{ url: "", kind: "verify" }, null])), null);
  });
});

describe("failing with nothing to yield", () => {
  it("names the message", () => {
    assert.equal(messageLabel(base), 'msg_1 ("Confirm your email")');
    assert.equal(messageLabel({ ...base, subject: undefined }), "msg_1");
    assert.equal(noCodeError("mailsaiWaitForCode", base).message, 'mailsaiWaitForCode: the email msg_1 ("Confirm your email") has no code.');
  });

  it("names the kinds of links the message does have", () => {
    const m = withLinks([
      { url: "https://app.test/help", kind: "other" },
      { url: "https://app.test/blog", kind: "other" },
      { url: "https://app.test/unsubscribe", kind: "unsubscribe" },
    ]);
    assert.equal(
      noLinkError("mailsaiWaitForLink", m).message,
      'mailsaiWaitForLink: the email msg_1 ("Confirm your email") has no verify, sign_in or reset_password link. Its links: other (2), unsubscribe (1).'
    );
    assert.equal(noLinkError("mailsaiWaitForLink", base, "sign_in").message, 'mailsaiWaitForLink: the email msg_1 ("Confirm your email") has no link of kind "sign_in". It has no links.');
  });
});
