// Run on its own, twice: once with no MAILS_API_KEY at all, and once with MAILS_BASE_URL pointing
// at a closed port. RUN_KIND, which run.mjs sets, says which.

export {}; // a module, so its top-level names stay its own

const REACHED = "the command was expected to fail but did not";

describe("settings of @mailsai/cypress", () => {
  it("makes a plus address without an API key, and fails a wait clearly without one", function () {
    if (Cypress.expose("RUN_KIND") !== "missing-key") this.skip();
    cy.mailsaiPlusAddress("nokey").should("equal", "qa.stub+nokey@in.mails.test");
    cy.on("fail", (err) => {
      expect(err.message).not.to.equal(REACHED);
      expect(err.message).to.equal(
        "mailsaiWaitForCode needs MAILS_API_KEY: a mails.ai API key with the read scope. Set it in the env block of cypress.config.ts (env: { MAILS_API_KEY: process.env.MAILS_API_KEY }) or as the environment variable CYPRESS_MAILS_API_KEY."
      );
      return false;
    });
    cy.mailsaiWaitForCode({ to: "qa.stub+nokey@in.mails.test" });
    cy.then(() => {
      throw new Error(REACHED);
    });
  });

  it("fails without leaking the key when the API cannot be reached", function () {
    if (Cypress.expose("RUN_KIND") !== "closed-port") this.skip();
    cy.env(["MAILS_API_KEY"], { log: false }).then(({ MAILS_API_KEY }) => {
      expect(MAILS_API_KEY).to.be.a("string").and.not.be.empty;
      cy.on("fail", (err) => {
        expect(err.message).not.to.equal(REACHED);
        expect(err.message).to.contain("failed trying to load:");
        expect(err.message).not.to.contain(MAILS_API_KEY);
        expect(err.message).not.to.contain("Bearer");
        return false;
      });
    });
    cy.mailsaiWaitForCode({ to: "qa.stub+closed@in.mails.test", timeout: 0 });
    cy.then(() => {
      throw new Error(REACHED);
    });
  });
});
