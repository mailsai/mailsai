// The real Cypress run of @mailsai/cypress. It packs the built package as npm would publish it,
// installs that tarball here beside Cypress, starts server.mjs (a stand-in for the mails.ai wait
// route plus a small sign-up page), runs the specs headless and stops the stub. `npm run test:e2e`
// in packages/cypress builds the package first, then runs this file.
//
// Some specs need settings of their own, so it is four Cypress runs:
//   main          signup, failures, log   the stub's address and a key made up for this run
//   missing-key   settings                no MAILS_API_KEY at all
//   closed-port   settings                MAILS_BASE_URL at a port nothing listens on
//   long-address  long-address            a receiving address with 52 characters before the @
// The made-up key must appear in no run's output. Before the runs, on Cypress 15.10 or later (the
// version the specs are written for), it type-checks the specs and the config with tsc.
//
// E2E_CYPRESS_VERSION=13.0.0 installs that Cypress instead of the one package.json names. Before
// Cypress 15.10 there is no cy.env(), which failures and settings use to read the key, so on such a
// version the main run is signup, log and without-cy-env.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const windows = process.platform === "win32";

/** Runs a command to its end with its output shown, or captured; throws when it fails. */
function must(command, args, cwd, capture = false) {
  const r = spawnSync(command, args, { cwd, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", shell: windows });
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

/** One headless Cypress run, its output shown as it comes and searched for the key. */
function cypressRun(name, specs, env, key) {
  return new Promise((ok) => {
    const bin = join(here, "node_modules", ".bin", windows ? "cypress.cmd" : "cypress");
    const spec = specs.map((s) => `cypress/e2e/${s}.cy.ts`).join(",");
    const child = spawn(bin, ["run", "--spec", spec], { cwd: here, env, shell: windows });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("error", (err) => ok({ name, code: err.message, leaked: false }));
    child.on("close", (code, signal) => ok({ name, code: code ?? signal, leaked: output.includes(key) }));
  });
}

// Every run gets this shell's environment without the mails.ai settings it may carry, so a real
// key or address set here never reaches the specs.
const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CYPRESS_)?MAILS_/.test(name)));

const work = mkdtempSync(join(tmpdir(), "mailsai-cypress-e2e-"));
let stub = null;
const stopStub = () => {
  if (stub && stub.exitCode === null) stub.kill();
};
process.on("exit", stopStub);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

try {
  const [packed] = JSON.parse(must("npm", ["pack", "--json", "--pack-destination", work], packageDir, true));
  console.log(`Packed ${packed.filename}: ${packed.files.map((f) => f.path).join(", ")}`);
  rmSync(join(here, "node_modules", "@mailsai", "cypress"), { recursive: true, force: true });
  const cypressSpec = process.env.E2E_CYPRESS_VERSION ? [`cypress@${process.env.E2E_CYPRESS_VERSION}`] : [];
  must("npm", ["install", "--no-audit", "--no-fund", "--no-save", "--no-package-lock", join(work, packed.filename), ...cypressSpec], here);
  const version = JSON.parse(readFileSync(join(here, "node_modules", "cypress", "package.json"), "utf8")).version;
  const [major, minor] = version.split(".").map(Number);
  const hasCyEnv = major > 15 || (major === 15 && minor >= 10);

  if (hasCyEnv) {
    const tsc = join(here, "node_modules", ".bin", windows ? "tsc.cmd" : "tsc");
    must(tsc, ["-p", "cypress/tsconfig.json", "--noEmit"], here);
    must(tsc, ["-p", "tsconfig.json", "--noEmit"], here);
    console.log(`Type-checked the specs and cypress.config.ts against Cypress ${version}.`);
  }

  const port = await freePort();
  const key = `mk_test_stub_${randomBytes(8).toString("hex")}`;
  stub = spawn(process.execPath, [join(here, "server.mjs")], { env: { ...base, STUB_PORT: String(port), STUB_API_KEY: key }, stdio: ["ignore", "inherit", "inherit"] });
  await waitUntilUp(`http://127.0.0.1:${port}/`);
  const closedPort = await freePort();

  const env = (extra) => ({ ...base, STUB_PORT: String(port), CYPRESS_MAILS_RECEIVING_ADDRESS: "qa.stub@in.mails.test", ...extra });
  const longAddress = ["long-address", ["long-address"], env({ STUB_API_KEY: key, CYPRESS_MAILS_RECEIVING_ADDRESS: `${"q".repeat(52)}@in.mails.test` })];
  const runs = hasCyEnv
    ? [
        ["main", ["signup", "failures", "log"], env({ STUB_API_KEY: key, RUN_KIND: "main" })],
        ["missing-key", ["settings"], env({ RUN_KIND: "missing-key" })],
        ["closed-port", ["settings"], env({ STUB_API_KEY: key, STUB_BASE_URL: `http://127.0.0.1:${closedPort}`, RUN_KIND: "closed-port" })],
        longAddress,
      ]
    : [["main", ["signup", "log", "without-cy-env"], env({ STUB_API_KEY: key })], longAddress];

  rmSync(join(here, "cypress", "screenshots"), { recursive: true, force: true });
  const results = [];
  for (const [name, specs, runEnv] of runs) results.push(await cypressRun(name, specs, runEnv, key));
  console.log(`\n@mailsai/cypress on Cypress ${version}:`);
  for (const r of results) {
    const problems = [r.code === 0 ? "" : `exit ${r.code}`, r.leaked ? "the key appeared in its output" : ""].filter(Boolean);
    console.log(`  ${problems.length ? "✖" : "✔"} ${r.name}${problems.length ? ` (${problems.join("; ")})` : ""}`);
  }
  if (results.some((r) => r.code !== 0 || r.leaked)) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopStub();
  rmSync(work, { recursive: true, force: true });
}
