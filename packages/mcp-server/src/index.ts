#!/usr/bin/env node
// @mailsai/mcp-server — Model Context Protocol server for the Mails.ai API.
// Runs client-side. Reads MAILS_API_KEY from env. Exposes every API operation as a tool
// (tools.ts): the send/receive/thread primitive, the two-way sandbox loop (mails_test_inbound,
// which runs the reputation firewall live on a test key) and the rest of the API.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMailsMcpServer } from "./server.ts";
import { MCP_SERVER_VERSION, TOOLS, credentialFromMe, toolsFor, type Credential, type MeResponse } from "./tools.ts";

const apiKey = process.env.MAILS_API_KEY;
if (!apiKey) {
  // This message is the FIRST thing most installs produce — an MCP client starts the server
  // before the developer has pasted a key, and the client only surfaces stderr. Saying what
  // is missing without saying where to get it makes that a dead end, so name the URL.
  console.error(
    "[mails-mcp] MAILS_API_KEY is not set.\n" +
      "  Get one free at https://app.mails.ai/api-keys (a mk_test_… key runs the whole sandbox,\n" +
      "  sends nothing, and is never billed), then add it to your MCP server config:\n" +
      '    "env": { "MAILS_API_KEY": "mk_test_…" }'
  );
  process.exit(1);
}
const baseUrl = process.env.MAILS_BASE_URL;

// The tool list follows the key's scopes and mode, which only the API knows: asked once, on the
// first list or call. When the API cannot say (offline, a bad key), every tool is listed and the
// API answers each call itself, as before 0.3.
let credential: Promise<Credential | null> | undefined;
// Why the lookup gave no credential, for the line the server writes when it starts.
let lookupProblem = "";
const apiBase = (baseUrl || "https://api.mails.ai").replace(/\/+$/, "");
const lookUp = (): Promise<Credential | null> =>
  (credential ??= (async () => {
    try {
      const res = await fetch(`${apiBase}/v1/me`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": `mails-mcp/${MCP_SERVER_VERSION}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        lookupProblem =
          res.status === 401
            ? "the API refused MAILS_API_KEY (401), so every call will be refused too: check the key at https://app.mails.ai/api-keys"
            : `GET /v1/me answered ${res.status}`;
        return null;
      }
      const found = credentialFromMe((await res.json()) as MeResponse);
      if (!found) lookupProblem = "GET /v1/me did not describe the key";
      return found;
    } catch (err) {
      lookupProblem = `${apiBase} could not be reached (${err instanceof Error ? err.message : String(err)})`;
      return null;
    }
  })());

serveStdio(() => createMailsMcpServer({ apiKey, baseUrl, credential: lookUp }), {
  onerror: (err) => console.error("[mails-mcp] error:", err.message),
});
// Until 2026-10-06 this said "connected" whatever the lookup found, a refused key included.
void lookUp().then((c) =>
  console.error(
    c
      ? `[mails-mcp] ${MCP_SERVER_VERSION} connected (${toolsFor(c).length} tools).`
      : `[mails-mcp] ${MCP_SERVER_VERSION} started, but the key could not be looked up: ${lookupProblem}. All ${TOOLS.length} tools are listed, and the API answers each call itself.`
  )
);
