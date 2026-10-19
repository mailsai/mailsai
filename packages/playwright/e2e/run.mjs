// The real Playwright run of @mailsai/playwright. It packs the built package as npm would publish
// it, installs that tarball here beside Playwright, installs Chromium's headless shell into this
// folder's own node_modules (never the shared browser cache, which `playwright install` prunes),
// type-checks the specs and the config, starts server.mjs (a stand-in for the mails.ai wait route
// plus a small sign-up page), runs Playwright headless and stops the stub. `npm run test:e2e` in
// packages/playwright builds the package first, then runs this file. Modelled on
// packages/cypress/e2e/run.mjs.
//
// Some specs need settings of their own, so it is five Playwright runs:
//   main          signup, failures, plain, esm   the stub's address and a key made up for this run
//   missing-key   settings                        no MAILS_API_KEY at all
//   closed-port   settings                        MAILS_BASE_URL at a port nothing listens on
//   long-address  long-address                    a receiving address with 52 characters before the @
//   report        report/                         tests that fail on purpose: the run must fail, and
//                                                 its JSON report must show what a user would see
// The made-up key must appear nowhere: not in any run's output, any JSON report, or any file a run
// leaves in its output folder, the traces (zip files) opened and searched too.
//
// E2E_PLAYWRIGHT_VERSION=1.39.0 installs that @playwright/test instead of the one package.json names.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const windows = process.platform === "win32";
const bin = (name) => join(here, "node_modules", ".bin", windows ? `${name}.cmd` : name);
// Playwright's browsers for this run live here, inside node_modules (ignored by git and by the
// deploy), so installing them touches no other project's browsers.
const BROWSERS = join(here, "node_modules", ".cache", "ms-playwright");

/** Runs a command to its end with its output shown, or captured; throws when it fails. */
function must(command, args, cwd, { capture = false, env = process.env } = {}) {
  const r = spawnSync(command, args, { cwd, env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", shell: windows });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd} (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
  return r.stdout;
}

/** A port nothing listens on right now. */
function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

async function waitUntilUp(url, seconds = 10) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error(`the stub did not answer at ${url} within ${seconds} s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One headless Playwright run, its output shown as it comes and kept for the key search. */
function playwrightRun(name, filters, env) {
  return new Promise((ok) => {
    const child = spawn(bin("playwright"), ["test", ...filters], { cwd: here, env, shell: windows });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("error", (err) => ok({ name, code: err.message, output }));
    child.on("close", (code, signal) => ok({ name, code: code ?? signal, output }));
  });
}

/** Every entry of a zip file, uncompressed: the traces Playwright writes are zips. Reads the
 *  central directory, so sizes written after the data (a data descriptor) are known. */
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip file");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("a zip central directory entry is damaged");
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name} uses compression method ${method}`);
    entries.push({ name, data: method === 8 ? inflateRawSync(data) : data });
  }
  return entries;
}

/** Every file under `dir`, with each zip's entries as files of their own: [{ path, data }]. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...filesUnder(path));
      continue;
    }
    const data = readFileSync(path);
    out.push({ path, data });
    if (name.endsWith(".zip")) for (const entry of unzip(data)) out.push({ path: `${path}!${entry.name}`, data: entry.data });
  }
  return out;
}

/** Every test result of a Playwright JSON report: [{ title, file, status, duration, errors, steps }]. */
function resultsOf(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) for (const r of t.results ?? []) out.push({ title: spec.title, file: spec.file, ...r });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

/** The steps of a result, nested ones included. */
function stepsOf(steps) {
  return (steps ?? []).flatMap((s) => [s, ...stepsOf(s.steps)]);
}

const stripColour = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** A test error's message as the user reads it: Playwright's report puts the error's name before
 *  it ("Error: ", "TypeError: ", "MailsaiApiError: ") and colours some messages. */
function plainMessage(error) {
  return stripColour(error?.message ?? "").replace(/^(?:[A-Z]\w*)?Error: /, "").trimEnd();
}

/** What the report run must show, checked against its JSON report and the list reporter's output
 *  (`output`): one line per check. */
function checkReport(report, specFile, output) {
  const source = readFileSync(specFile, "utf8").split("\n");
  const lineOf = (mark) => source.findIndex((l) => l.includes(`// report-line: ${mark}`)) + 1;
  const results = resultsOf(report);
  const byTitle = (start) => results.find((r) => r.title.startsWith(start));
  const checks = [];
  const check = (what, ok, got) => checks.push({ what, ok: Boolean(ok), got });
  // Where the report puts a failure: the JSON report's errorLocation, and the line the list
  // reporter marks with ">" in the code it prints under the error.
  const reportedAt = (result, mark) => {
    const at = result?.errorLocation;
    const framed = stripColour(output).split("\n").some((l) => new RegExp(`^\\s*> ${lineOf(mark)} \\|.*// report-line: ${mark}$`).test(l));
    return { ok: at?.file === specFile && at?.line === lineOf(mark) && framed, got: { errorLocation: at, codeFrameMarksTheLine: framed } };
  };

  const nothing = byTitle("a wait that finds nothing");
  check("a wait that finds nothing fails, not times out", nothing?.status === "failed", nothing?.status);
  check(
    "its message is the wait's own, naming its filters",
    /^mails\.waitForCode: no email arrived within 4 s matching to: qa\.stub\+run-[0-9a-z]+-[0-9a-z]{4}@in\.mails\.test, has: code\.$/.test(plainMessage(nothing?.error)),
    plainMessage(nothing?.error)
  );
  const nothingAt = reportedAt(nothing, "nothing");
  check("it is reported at the line that called the wait", nothingAt.ok, nothingAt.got);
  const step = stepsOf(nothing?.steps).find((s) => s.title.startsWith("mails.waitForCode to: qa.stub+run-"));
  check("it ran as a step titled with its filters", step && /^mails\.waitForCode to: \S+, has: code, within 4 s$/.test(step.title) && step.error, step?.title);
  check("the test ran past its own 3 s timeout, for the wait's 4 s", nothing?.duration >= 4000, nothing?.duration);

  const paid = byTitle("a 402 fails at once");
  check(
    "a 402 fails with the code and the link to change plan",
    paid?.status === "failed" && /^mails\.waitForLink: mails\.ai answered 402 plan_limit_exceeded: .* Change your plan: https:\/\/app\.mails\.ai\/billing \(request req_stub_\d+\)$/.test(plainMessage(paid?.error)),
    plainMessage(paid?.error)
  );
  check("…at once", paid?.duration < 5000, paid?.duration);
  const paidAt = reportedAt(paid, "planlimit");
  check("…at the line that called the wait", paidAt.ok, paidAt.got);

  const option = byTitle("a misspelt option");
  const optionAt = reportedAt(option, "option");
  check(
    "a misspelt option fails before any request, at its line",
    plainMessage(option?.error) === 'mails.waitForLink has no option "kinds". Its options are to, from, since, timeout, agentId, kind.' && optionAt.ok,
    { message: plainMessage(option?.error), ...optionAt.got }
  );

  const control = byTitle("control:");
  check("control: without the fixture, the test timeout ends the wait first", control?.status === "timedOut" && /^Test timeout of 3000ms exceeded/.test(plainMessage(control?.error)), plainMessage(control?.error));
  return checks;
}

// Every run gets this shell's environment without the mails.ai settings it may carry, so a real
// key or address set here never reaches the specs; FORCE_COLOR=0 keeps colour codes out of the
// output (a few messages Playwright colours itself are cleaned by stripColour()).
const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^MAILS_/.test(name)));
base.FORCE_COLOR = "0";
base.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;

const work = mkdtempSync(join(tmpdir(), "mailsai-playwright-e2e-"));
let stub = null;
const stopStub = () => {
  if (stub && stub.exitCode === null) stub.kill();
};
process.on("exit", stopStub);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

try {
  const [packed] = JSON.parse(must("npm", ["pack", "--json", "--pack-destination", work], packageDir, { capture: true }));
  console.log(`Packed ${packed.filename}: ${packed.files.map((f) => f.path).join(", ")}`);
  rmSync(join(here, "node_modules", "@mailsai", "playwright"), { recursive: true, force: true });
  const playwrightSpec = process.env.E2E_PLAYWRIGHT_VERSION ? [`@playwright/test@${process.env.E2E_PLAYWRIGHT_VERSION}`] : [];
  must("npm", ["install", "--no-audit", "--no-fund", "--no-save", "--no-package-lock", join(work, packed.filename), ...playwrightSpec], here);
  const version = JSON.parse(readFileSync(join(here, "node_modules", "@playwright", "test", "package.json"), "utf8")).version;
  const onlyShell = must(bin("playwright"), ["install", "--help"], here, { capture: true, env: base }).includes("--only-shell");
  must(bin("playwright"), ["install", ...(onlyShell ? ["--only-shell"] : []), "chromium"], here, { env: base });

  must(bin("tsc"), ["-p", "tsconfig.json", "--noEmit"], here);
  console.log(`Type-checked the specs and playwright.config.ts against Playwright ${version}.`);

  const port = await freePort();
  const key = `mk_test_stub_${randomBytes(8).toString("hex")}`;
  stub = spawn(process.execPath, [join(here, "server.mjs")], { env: { ...base, STUB_PORT: String(port), STUB_API_KEY: key }, stdio: ["ignore", "inherit", "inherit"] });
  await waitUntilUp(`http://127.0.0.1:${port}/`);
  const closedPort = await freePort();

  rmSync(join(here, "test-results"), { recursive: true, force: true });
  const env = (name, extra) => ({
    ...base,
    STUB_PORT: String(port),
    RUN_KIND: name,
    E2E_OUTPUT_DIR: `test-results/${name}`,
    E2E_JSON: `test-results/${name}.json`,
    MAILS_RECEIVING_ADDRESS: "qa.stub@in.mails.test",
    MAILS_BASE_URL: `http://127.0.0.1:${port}`,
    MAILS_API_KEY: key,
    ...extra,
  });
  const withoutKey = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "MAILS_API_KEY"));
  const runs = [
    ["main", ["signup", "failures", "plain", "esm/"], env("main"), 0],
    ["missing-key", ["settings"], withoutKey(env("missing-key")), 0],
    ["closed-port", ["settings"], env("closed-port", { MAILS_BASE_URL: `http://127.0.0.1:${closedPort}` }), 0],
    ["long-address", ["long-address"], env("long-address", { MAILS_RECEIVING_ADDRESS: `${"q".repeat(52)}@in.mails.test` }), 0],
    ["report", [], env("report"), 1],
  ];

  const results = [];
  for (const [name, filters, runEnv, expected] of runs) {
    const run = await playwrightRun(name, filters, runEnv);
    const jsonPath = join(here, runEnv.E2E_JSON);
    const report = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : null;
    results.push({ ...run, expected, report });
  }

  console.log(`\n@mailsai/playwright on Playwright ${version}:`);
  let failed = false;
  for (const r of results) {
    // Counted from the results, since the report's stats have no counts before Playwright 1.40.
    const statuses = r.report ? resultsOf(r.report).map((t) => t.status) : [];
    const n = (...kinds) => statuses.filter((s) => kinds.includes(s)).length;
    const counts = `${n("passed")} passed, ${n("failed", "timedOut", "interrupted")} failed, ${n("skipped")} skipped`;
    const problems = [r.code === r.expected ? "" : `exit ${r.code}, expected ${r.expected}`, r.report ? "" : "no JSON report"].filter(Boolean);
    if (problems.length) failed = true;
    console.log(`  ${problems.length ? "✖" : "✔"} ${r.name}: ${counts}${r.expected ? " (these tests fail on purpose)" : ""}${problems.length ? ` (${problems.join("; ")})` : ""}`);
  }

  const reportRun = results.find((r) => r.name === "report");
  console.log("\nThe report run, as Playwright's JSON report shows it:");
  for (const c of reportRun.report ? checkReport(reportRun.report, join(here, "tests", "report", "expected-failures.spec.ts"), reportRun.output) : [{ what: "the report run wrote its JSON report", ok: false }]) {
    if (!c.ok) failed = true;
    console.log(`  ${c.ok ? "✔" : "✖"} ${c.what}${c.ok ? "" : `: got ${JSON.stringify(c.got)}`}`);
  }

  const files = filesUnder(join(here, "test-results"));
  const traces = files.filter((f) => f.path.endsWith("trace.zip")).length;
  const leaks = [
    ...results.filter((r) => r.output.includes(key)).map((r) => `the output of the ${r.name} run`),
    ...files.filter((f) => f.data.includes(key)).map((f) => f.path.slice(here.length + 1)),
  ];
  if (leaks.length) failed = true;
  console.log(`\nThe key in ${results.length} runs' output and ${files.length} files (${traces} traces opened): ${leaks.length ? `FOUND in ${leaks.join(", ")}` : "found nowhere"}`);
  if (traces === 0) {
    failed = true;
    console.log("  ✖ no trace was written, so the search proves nothing about them");
  }
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopStub();
  rmSync(work, { recursive: true, force: true });
}
