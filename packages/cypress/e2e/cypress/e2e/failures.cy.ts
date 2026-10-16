// The failure paths. Each failing command is caught with cy.on("fail") and its message checked; a
// command after it throws if reached, so a wait that wrongly succeeds cannot pass vacuously.

// A second import of the package, besides the support file's: it must be harmless.
import "@mailsai/cypress";

const REACHED = "the command was expected to fail but did not";

function expectFailure(check: (message: string) => void) {
  cy.env(["MAILS_API_KEY"], { log: false }).then(({ MAILS_API_KEY }) => {
    expect(MAILS_API_KEY, "the key is set for this run").to.be.a("string").and.not.be.empty;
    cy.on("fail", (err) => {
      expect(err.message).not.to.equal(REACHED);
      expect(err.message, "the key never appears in a failure").not.to.contain(MAILS_API_KEY);
      check(err.message);
      return false;
    });
  });
}

describe("failures of @mailsai/cypress", () => {
  it("fails with the filters named when nothing arrives within a short timeout", () => {
    cy.mailsaiPlusAddress().then((email) => {
      expectFailure((message) => {
        expect(message).to.equal(`mailsaiWaitForCode: no email arrived within 2 s matching to: ${email}, has: code.`);
      });
      cy.mailsaiWaitForCode({ to: email, timeout: 2 });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });

  let fastAddress = "";

  it("spends a 60 s timeout as a 50 s wait and a 10 s wait (the stub holds 1/50 of each)", () => {
    cy.mailsaiPlusAddress("fast-" + Date.now().toString(36)).then((email) => {
      fastAddress = email;
      expectFailure((message) => {
        expect(message).to.equal(`mailsaiWaitForMessage: no email arrived within 60 s matching to: ${email}.`);
      });
      cy.mailsaiWaitForMessage({ to: email });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });

  it("…and the stub saw exactly those two calls", () => {
    cy.request(`/test/calls?to=${encodeURIComponent(fastAddress)}`)
      .its("body")
      .then((calls: { timeout: number; has: string | null }[]) => {
        expect(calls.map((c) => c.timeout)).to.deep.equal([50, 10]);
        expect(calls.every((c) => c.has === null)).to.equal(true);
      });
  });

  it("fails with the API's error code and message", () => {
    cy.mailsaiPlusAddress("forbidden-" + Date.now().toString(36)).then((email) => {
      expectFailure((message) => {
        expect(message).to.match(/^mailsaiWaitForCode: mails\.ai answered 403 insufficient_scope: This API key does not have the read scope\. \(request req_stub_\d+\)$/);
      });
      cy.mailsaiWaitForCode({ to: email, timeout: 5 });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });

  let planLimitAddress = "";

  it("fails at once with the link to change plan when the plan's daily plus-address limit refused the mail", () => {
    cy.mailsaiPlusAddress("planlimit-" + Date.now().toString(36)).then((email) => {
      planLimitAddress = email;
      expectFailure((message) => {
        expect(message).to.match(
          new RegExp(
            `^mailsaiWaitForCode: mails\\.ai answered 402 plan_limit_exceeded: Mail to ${email.replace(/[.+]/g, "\\$&")} arrived but was not kept: .* Upgrade, or reuse a plus address that already received mail today\\. Change your plan: https://app\\.mails\\.ai/billing \\(request req_stub_\\d+\\)$`
          )
        );
      });
      cy.mailsaiWaitForCode({ to: email });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });

  it("…after one call: no retry", () => {
    cy.request(`/test/calls?to=${encodeURIComponent(planLimitAddress)}`)
      .its("body")
      .then((calls: { timeout: number; status: number }[]) => {
        expect(calls.map((c) => [c.timeout, c.status])).to.deep.equal([[50, 402]]);
      });
  });

  it("refuses a misspelt option before making any request", () => {
    expectFailure((message) => {
      expect(message).to.equal('mailsaiWaitForLink has no option "To". Its options are to, from, since, timeout, agentId, kind.');
    });
    // @ts-expect-error: "To" is not an option, and the types say so too.
    cy.mailsaiWaitForLink({ To: "qa.stub+x@in.mails.test" });
    cy.then(() => {
      throw new Error(REACHED);
    });
  });

  it("refuses an empty to rather than waiting for anyone's mail", () => {
    expectFailure((message) => {
      expect(message).to.equal("mailsaiWaitForCode: to is empty. Give a value, or leave to out.");
    });
    cy.mailsaiWaitForCode({ to: "" });
    cy.then(() => {
      throw new Error(REACHED);
    });
  });

  it("fails without leaking the key when the API never answers (cy.request times out)", () => {
    cy.mailsaiPlusAddress("hang-" + Date.now().toString(36)).then((email) => {
      expectFailure((message) => {
        // Cypress 16.2 reports a request that never answers with either message, whichever of its
        // two timers fires first; both print the method and the URL only.
        expect(message).to.match(/timed out waiting `15000ms` for a response|ESOCKETTIMEDOUT/);
        expect(message).to.contain("Method: GET");
        expect(message).not.to.contain("Bearer");
        expect(message.toLowerCase()).not.to.contain("authorization");
      });
      cy.mailsaiWaitForCode({ to: email, timeout: 0 });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });
});
