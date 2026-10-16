// The happy paths, as a user would write them: a plus address per run, the code or link sent to it.

export {}; // a module, so its top-level names stay its own

type SignupState = { code: string; token: string; decoyAddress: string; decoyCode: string; decoyToken: string };

const stateOf = (email: string) => cy.request<SignupState>(`/test/state?email=${encodeURIComponent(email)}`).its("body");

function signUp(email: string) {
  cy.visit("/");
  cy.get("[data-cy=email]").type(email);
  cy.get("[data-cy=submit]").click();
  cy.contains("[data-cy=result]", "Check your email for a code");
}

describe("sign-up with @mailsai/cypress", () => {
  it("signs up with a plus address and types the code sent to it, not the decoy's", () => {
    cy.mailsaiPlusAddress().then((email) => {
      expect(email).to.match(/^qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test$/);
      signUp(email);
      cy.mailsaiWaitForCode({ to: email }).then((code) => {
        stateOf(email).then((state) => {
          expect(code, "the code of the email sent to this address").to.equal(state.code);
          expect(code, "not the decoy's code").not.to.equal(state.decoyCode);
          expect(state.decoyAddress).not.to.equal(email);
        });
        cy.get("[data-cy=code]").type(code);
      });
      cy.get("[data-cy=verify]").click();
      cy.contains("[data-cy=result]", "Your account is verified");
    });
  });

  it("yields the verify link of the email sent to this address, never its unsubscribe link", () => {
    cy.mailsaiPlusAddress().then((email) => {
      signUp(email);
      cy.mailsaiWaitForLink({ to: email }).then((url) => {
        stateOf(email).then((state) => {
          expect(url).to.equal(`${Cypress.config("baseUrl")}/verify?token=${state.token}`);
          expect(url).not.to.contain(state.decoyToken);
          expect(url).not.to.contain("unsubscribe");
        });
        cy.visit(url);
      });
      cy.contains("[data-cy=verified]", `Email verified for ${email}`);
    });
  });

  it("yields the first link of the kind asked for", () => {
    cy.mailsaiPlusAddress("kind-" + Date.now().toString(36)).then((email) => {
      signUp(email);
      cy.mailsaiWaitForLink({ to: email, kind: "other" }).should("equal", `${Cypress.config("baseUrl")}/help`);
      cy.mailsaiWaitForLink({ to: email, kind: "verify" }).should("match", /\/verify\?token=[0-9a-f]{16}$/);
    });
  });

  it("yields the whole message for the address it was sent to", () => {
    cy.mailsaiPlusAddress().then((email) => {
      signUp(email);
      cy.mailsaiWaitForMessage({ to: email, has: "code", from: "app.test", timeout: 20 }).then((message) => {
        expect(message.delivered_to).to.equal(email);
        expect(message.subject).to.equal("Confirm your email");
        expect(message.codes).to.have.length(1);
        expect(message.links?.map((l) => l.kind)).to.deep.equal(["unsubscribe", "other", "verify"]);
      });
    });
  });

  it("waits out a 429 and tries again within the same timeout", () => {
    cy.mailsaiPlusAddress("limited-" + Date.now().toString(36)).then((email) => {
      cy.request("POST", "/test/deliver", { to: email, codes: [{ value: "777111" }], links: [], subject: "Your code" });
      cy.mailsaiWaitForCode({ to: email, timeout: 10 }).should("equal", "777111");
      cy.request(`/test/calls?to=${encodeURIComponent(email)}`)
        .its("body")
        .then((calls: { timeout: number; status: number }[]) => {
          expect(calls.map((c) => c.status)).to.deep.equal([429, 200]);
          // The 1 s pause came out of the 10 s timeout.
          expect(calls.map((c) => c.timeout)).to.deep.equal([10, 9]);
        });
    });
  });
});
