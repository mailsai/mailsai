import { defineConfig } from "@playwright/test";

// run.mjs sets the environment of each run: the stub's port, the settings @mailsai/playwright reads
// (MAILS_API_KEY, MAILS_RECEIVING_ADDRESS, MAILS_BASE_URL), RUN_KIND, and where the run writes its
// results. The report run (tests/report) holds tests that fail on purpose, so run.mjs can read how
// a failure looks in Playwright's own report; every other run leaves that folder out.
const port = process.env.STUB_PORT;
const report = process.env.RUN_KIND === "report";

export default defineConfig({
  testDir: report ? "tests/report" : "tests",
  testIgnore: report ? [] : ["**/report/**"],
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  // Playwright's own default, said out loud: the fixture's waits are meant to work inside it.
  timeout: 30_000,
  workers: 4,
  fullyParallel: true,
  reporter: [["list"], ["json", { outputFile: process.env.E2E_JSON ?? "test-results/report.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Every test keeps a trace, which run.mjs searches for the API key with the rest of the output.
    trace: "on",
  },
});
