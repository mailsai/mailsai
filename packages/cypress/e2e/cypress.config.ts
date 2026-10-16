import { defineConfig } from "cypress";

// run.mjs sets the environment of each run: the stub's port and key, or for the settings runs no
// key or a base URL nothing answers at. The key and the base URL come through the env block, read
// from the environment here; MAILS_RECEIVING_ADDRESS comes as CYPRESS_MAILS_RECEIVING_ADDRESS, to
// prove the prefix path too.
const port = process.env.STUB_PORT;

export default defineConfig({
  // run.mjs empties cypress/screenshots once before its runs, so the Command Log screenshot of the
  // main run (log.cy.ts) is still there after the runs that follow it.
  trashAssetsBeforeRuns: false,
  e2e: {
    baseUrl: `http://127.0.0.1:${port}`,
    supportFile: "cypress/support/e2e.ts",
  },
  env: {
    MAILS_API_KEY: process.env.STUB_API_KEY,
    MAILS_BASE_URL: process.env.STUB_BASE_URL ?? `http://127.0.0.1:${port}`,
  },
  expose: {
    RUN_KIND: process.env.RUN_KIND ?? "main",
  },
});
