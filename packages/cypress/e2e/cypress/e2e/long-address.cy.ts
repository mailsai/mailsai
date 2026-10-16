// Run on its own (run.mjs's long-address run) with a receiving address whose part before the @ has
// 52 characters, which leaves room for an 11-character tag under the 64-character limit.

export {}; // a module, so its top-level names stay its own

const REACHED = "the command was expected to fail but did not";

describe("@mailsai/cypress with a long receiving address", () => {
  it("shortens the default tag to fill the part before the @ to exactly 64, and the flow still works", () => {
    cy.mailsaiPlusAddress().then((email) => {
      expect(email).to.match(/^q{52}\+[0-9a-z]{11}@in\.mails\.test$/);
      expect(email.split("@")[0]).to.have.length(64);
      cy.visit("/");
      cy.get("[data-cy=email]").type(email);
      cy.get("[data-cy=submit]").click();
      cy.mailsaiWaitForCode({ to: email }).then((code) => cy.get("[data-cy=code]").type(code));
      cy.get("[data-cy=verify]").click();
      cy.contains("[data-cy=result]", "Your account is verified");
    });
  });

  it("fails naming the room when a tag of your own is too long", () => {
    cy.on("fail", (err) => {
      expect(err.message).not.to.equal(REACHED);
      expect(err.message).to.equal(
        `The part of an address before the @ holds at most 64 characters, so a tag on ${"q".repeat(52)}@in.mails.test can have at most 11. Received 12: "signup-12345"`
      );
      return false;
    });
    cy.mailsaiPlusAddress("signup-12345");
    cy.then(() => {
      throw new Error(REACHED);
    });
  });
});
