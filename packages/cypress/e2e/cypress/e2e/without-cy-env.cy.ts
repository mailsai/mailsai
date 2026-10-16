// On a Cypress without cy.env() (before 15.10), @mailsai/cypress reads its settings with
// Cypress.env(). run.mjs runs this spec, with signup, log and long-address, when
// E2E_CYPRESS_VERSION installs such a Cypress; CI runs 13.0.0, the oldest the package supports.

export {}; // a module, so its top-level names stay its own

const REACHED = "the command was expected to fail but did not";

// Cypress 16's types no longer declare Cypress.env().
const envOf = (key: string) => (Cypress as unknown as { env(key: string): unknown }).env(key);

describe("@mailsai/cypress on a Cypress without cy.env()", () => {
  it("runs where cy.env() does not exist", () => {
    expect(typeof (cy as unknown as { env?: unknown }).env).to.equal("undefined");
  });

  it("fails with the filters named, and without the key, when nothing arrives", () => {
    const key = envOf("MAILS_API_KEY") as string;
    expect(key).to.be.a("string").and.not.be.empty;
    cy.mailsaiPlusAddress("legacy-none").then((email) => {
      cy.on("fail", (err) => {
        expect(err.message).not.to.equal(REACHED);
        expect(err.message).to.equal(`mailsaiWaitForCode: no email arrived within 1 s matching to: ${email}, has: code.`);
        expect(err.message).not.to.contain(key);
        return false;
      });
      cy.mailsaiWaitForCode({ to: email, timeout: 1 });
      cy.then(() => {
        throw new Error(REACHED);
      });
    });
  });
});
