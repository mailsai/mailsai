// Plus addresses: the same rules as plusAddress() in @mailsai/sdk (packages/sdk/src/index.ts), and
// the tag mailsaiPlusAddress makes when it is given none. Runs against the build: npm run check:cypress.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultTag, MIN_UNIQUE_TAG, plusAddress, plusAddressFor, tagRoom } from "../dist/core.js";

/** A receiving address whose part before the @ has `n` characters. */
const receiving = (n) => `${"q".repeat(n)}@in.mails.ai`;
const localOf = (address) => address.slice(0, address.lastIndexOf("@"));

describe("plusAddress", () => {
  it("puts +tag before the @ of the receiving address", () => {
    assert.equal(plusAddress("qa.acme@in.mails.ai", "run-1842"), "qa.acme+run-1842@in.mails.ai");
    assert.equal(plusAddress("billing@acme.com", "t1"), "billing+t1@acme.com");
  });

  it("trims the tag of ASCII whitespace and lowercases it", () => {
    assert.equal(plusAddress("qa.acme@in.mails.ai", "  Run-1842 "), "qa.acme+run-1842@in.mails.ai");
    assert.equal(plusAddress("qa.acme@in.mails.ai", "\t\r\nRun-1842\n"), "qa.acme+run-1842@in.mails.ai");
  });

  it("trims no other whitespace, as the Python SDK does not", () => {
    for (const tag of [" run-1", "run-1 ", "\u000brun-1"]) {
      assert.throws(() => plusAddress("qa@in.mails.ai", tag), { message: `A tag is 1 to 40 letters, digits, ".", "_", "-" or "+". Received: ${JSON.stringify(tag)}` }, JSON.stringify(tag));
    }
  });

  it("lowercases the whole address", () => {
    assert.equal(plusAddress("QA.Acme@IN.Mails.AI", "x"), "qa.acme+x@in.mails.ai");
  });

  it("keeps only the local part before its first +", () => {
    assert.equal(plusAddress("qa.acme+old@in.mails.ai", "new"), "qa.acme+new@in.mails.ai");
    assert.equal(plusAddress("qa+a+b@in.mails.ai", "new"), "qa+new@in.mails.ai");
  });

  it("takes letters, digits, '.', '_', '-' and '+' in a tag, 1 to 40 of them", () => {
    assert.equal(plusAddress("qa@in.mails.ai", "a.b_c-d+e"), "qa+a.b_c-d+e@in.mails.ai");
    assert.equal(plusAddress("qa@in.mails.ai", "z"), "qa+z@in.mails.ai");
    const forty = "a".repeat(40);
    assert.equal(plusAddress("qa@in.mails.ai", forty), `qa+${forty}@in.mails.ai`);
  });

  it("refuses any other tag with the SDK's message", () => {
    const message = (tag) => `A tag is 1 to 40 letters, digits, ".", "_", "-" or "+". Received: ${JSON.stringify(tag)}`;
    for (const tag of ["", "   ", "a".repeat(41), "run 1", "run/1", "run@1", "é", "run#1"]) {
      assert.throws(() => plusAddress("qa@in.mails.ai", tag), { message: message(tag) }, `tag ${JSON.stringify(tag)}`);
    }
  });

  it("refuses a receiving address with no @ or nothing before it", () => {
    assert.throws(() => plusAddress("qa.acme", "x"), { message: 'Not an address: "qa.acme"' });
    assert.throws(() => plusAddress("@in.mails.ai", "x"), { message: 'Not an address: "@in.mails.ai"' });
    assert.throws(() => plusAddress("", "x"), { message: 'Not an address: ""' });
  });

  it("refuses any tag on a receiving address whose part before the @ already has 64 characters", () => {
    const full = receiving(64);
    assert.throws(() => plusAddress(full, "t"), {
      message: `${full} has no room for a tag: the part of an address before the @ holds at most 64 characters, and it already has 64.`,
    });
    // 63 leaves room for the + and nothing after it.
    assert.throws(() => plusAddress(receiving(63), "t"), { message: /has no room for a tag: .* and it already has 63\.$/ });
  });

  it("refuses a tag longer than the room a 52-character receiving address leaves, naming the room", () => {
    const address = receiving(52);
    const tag = "Run-123456789";
    assert.throws(() => plusAddress(address, tag), {
      message: `The part of an address before the @ holds at most 64 characters, so a tag on ${address} can have at most 11. Received 13: ${JSON.stringify(tag)}`,
    });
  });

  it("takes a tag that fills the part before the @ to exactly 64 characters", () => {
    const address = plusAddress(receiving(52), "abcdefghijk");
    assert.equal(address, `${"q".repeat(52)}+abcdefghijk@in.mails.ai`);
    assert.equal(localOf(address).length, 64);
  });

  it("counts the receiving address's part before its first + only, as that is what is kept", () => {
    const address = `${"q".repeat(60)}+old@in.mails.ai`;
    assert.equal(plusAddress(address, "abc"), `${"q".repeat(60)}+abc@in.mails.ai`);
    assert.throws(() => plusAddress(address, "abcd"), { message: /can have at most 3\. Received 4: "abcd"$/ });
  });
});

describe("tagRoom", () => {
  it("is 40, or what the part before the @ leaves under 64", () => {
    assert.equal(tagRoom("qa.acme@in.mails.ai"), 40);
    assert.equal(tagRoom(receiving(23)), 40);
    assert.equal(tagRoom(receiving(24)), 39);
    assert.equal(tagRoom(receiving(52)), 11);
    assert.equal(tagRoom(receiving(63)), 0);
    assert.equal(tagRoom(receiving(64)), -1);
    assert.equal(tagRoom(`${"q".repeat(52)}+old@in.mails.ai`), 11);
  });
});

describe("defaultTag", () => {
  it("is run-, the time in base 36 and 4 random characters", () => {
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);
    assert.equal(defaultTag(now, () => "abcd"), `run-${now.toString(36)}-abcd`);
    assert.equal(defaultTag(0, () => "zz99"), "run-0-zz99");
  });

  it("asks the random source for exactly 4 characters", () => {
    let asked = 0;
    defaultTag(1, (n) => ((asked = n), "x".repeat(n)));
    assert.equal(asked, 4);
  });

  it("makes tags a plus address takes, 17 characters today", () => {
    for (let i = 0; i < 50; i++) {
      const tag = defaultTag();
      assert.match(tag, /^run-[0-9a-z]+-[0-9a-z]{4}$/);
      assert.equal(tag.length, 17);
      assert.equal(plusAddress("qa@in.mails.ai", tag), `qa+${tag}@in.mails.ai`);
    }
  });

  it("makes different tags in the same millisecond", () => {
    const now = Date.now();
    const seen = new Set(Array.from({ length: 20 }, () => defaultTag(now)));
    assert.ok(seen.size >= 19, `${seen.size} different tags of 20`);
  });

  it("is only random characters, as many as fit, when the room is under 17", () => {
    const asked = [];
    const random = (n) => (asked.push(n), "z".repeat(n));
    assert.equal(defaultTag(Date.UTC(2026, 9, 16), random, 11), "zzzzzzzzzzz");
    assert.equal(defaultTag(Date.UTC(2026, 9, 16), random, 16), "z".repeat(16));
    assert.equal(defaultTag(Date.UTC(2026, 9, 16), random, MIN_UNIQUE_TAG), "z".repeat(MIN_UNIQUE_TAG));
    assert.deepEqual(asked, [11, 16, MIN_UNIQUE_TAG]);
    const now = Date.UTC(2026, 9, 16);
    assert.equal(defaultTag(now, () => "abcd", 17), `run-${now.toString(36)}-abcd`);
  });

  it("keeps the full tag when fewer than 6 random characters would fit, for plusAddress to refuse", () => {
    const now = Date.UTC(2026, 9, 16);
    assert.equal(defaultTag(now, () => "abcd", MIN_UNIQUE_TAG - 1), `run-${now.toString(36)}-abcd`);
    assert.equal(defaultTag(now, () => "abcd", -1), `run-${now.toString(36)}-abcd`);
  });
});

describe("plusAddressFor", () => {
  it("is a plus address with a new default tag when none is given", () => {
    assert.match(plusAddressFor("qa.stub@in.mails.test", undefined), /^qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
    assert.match(plusAddressFor("qa.stub@in.mails.test", null), /^qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
  });

  it("uses the tag given, under plusAddress's rules", () => {
    assert.equal(plusAddressFor("qa.stub@in.mails.test", " Signup-1 "), "qa.stub+signup-1@in.mails.test");
    assert.throws(() => plusAddressFor("qa.stub@in.mails.test", "bad tag"), { message: /^A tag is 1 to 40 letters/ });
  });

  it("shortens the default tag to fit a long receiving address, and keeps it unique", () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const address = plusAddressFor(receiving(52), undefined);
      assert.match(address, /^q{52}\+[0-9a-z]{11}@in\.mails\.ai$/);
      assert.equal(localOf(address).length, 64);
      seen.add(address);
    }
    assert.ok(seen.size >= 19, `${seen.size} different addresses of 20`);
    assert.match(plusAddressFor(receiving(57), undefined), /^q{57}\+[0-9a-z]{6}@in\.mails\.ai$/);
  });

  it("fails with plusAddress's message when a default tag cannot fit and stay unique", () => {
    const address = receiving(58);
    assert.throws(() => plusAddressFor(address, undefined, Date.UTC(2026, 9, 16), () => "abcd"), {
      message: `The part of an address before the @ holds at most 64 characters, so a tag on ${address} can have at most 5. Received 17: "run-${Date.UTC(2026, 9, 16).toString(36)}-abcd"`,
    });
    assert.throws(() => plusAddressFor(receiving(64), undefined), { message: /has no room for a tag: .* and it already has 64\.$/ });
  });

  it("refuses a tag that is not a string", () => {
    assert.throws(() => plusAddressFor("qa@in.mails.ai", 42), { name: "TypeError", message: /takes a tag that is a string, or nothing\. Received: 42/ });
  });
});
