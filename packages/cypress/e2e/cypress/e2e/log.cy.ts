// What the Command Log shows for each command: captured as a screenshot of the runner to look at.

describe("the Command Log of @mailsai/cypress", () => {
  it("shows each command's filters and result, and no key", () => {
    cy.mailsaiPlusAddress().then((email) => {
      cy.visit("/");
      cy.get("[data-cy=email]").type(email);
      cy.get("[data-cy=submit]").click();
      cy.mailsaiWaitForCode({ to: email });
      cy.mailsaiWaitForLink({ to: email });
      cy.mailsaiWaitForMessage({ to: email, has: "link", timeout: 5 });
    });
    cy.screenshot("command-log", { capture: "runner" });
  });
});
