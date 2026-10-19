// A dependency-free stand-in for the mails.ai wait route plus a tiny sign-up app, for the real
// Playwright run of @mailsai/playwright: run.mjs starts it with STUB_PORT and STUB_API_KEY. Not the
// real API: just enough of its contract (app/api/v1/messages/received/wait/route.ts, and
// lib/errors.ts for the error body and the X-Request-Id header) to drive the package end to end.
// Modelled on packages/cypress/e2e/server.mjs.
//
//   GET  /                                   sign-up page: email -> code box -> verified
//   POST /api/signup {email}                 "delivers" a decoy (another plus address, other code)
//                                            at +600 ms and the real email at +1200 ms
//   POST /api/verify {email, code}           { verified }
//   GET  /verify?token=                      the page a verify link opens
//   GET  /api/v1/messages/received/wait      Bearer auth (401 without), to, from, has, since,
//                                            timeout 0..50
//   GET  /test/state?email=                  the code, token and decoy for a sign-up
//   GET  /test/calls?to=                     the wait calls made for an address
//   POST /test/deliver {to, codes, links, subject, delayMs}
//
// Addresses whose plus tag starts with these take a special path on the wait route:
//   limited…    the first wait is a 429 with Retry-After: 1
//   fast…       holds timeout/50 seconds, so a 50 s wait takes 1 s (to watch a timeout be split)
//   forbidden…  403 insufficient_scope
//   planlimit…  402 plan_limit_exceeded with upgrade_url, as the real route answers once mail to
//               `to` came past the plan's daily plus-address limit (lib/errors.ts adds the link)
//   hang…       never answers

import http from "node:http";
import { randomBytes, randomInt } from "node:crypto";

const PORT = Number(process.env.STUB_PORT);
const KEY = process.env.STUB_API_KEY;
if (!PORT || !KEY) throw new Error("STUB_PORT and STUB_API_KEY are required");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ACTION = ["verify", "sign_in", "reset_password"];

const messages = []; // oldest first
const signups = new Map();
const calls = new Map();
let seq = 0;

const tagOf = (address) => {
  const local = address.split("@")[0];
  const plus = local.indexOf("+");
  return plus < 0 ? "" : local.slice(plus + 1);
};

function deliver(to, { codes = [], links = [], subject = "Your code", from = "noreply@app.test" } = {}) {
  seq += 1;
  messages.push({
    id: `msg_${seq}`,
    agent_id: "agt_stub",
    from: { address: from, name: "Stub App" },
    to: to.replace(/\+[^@]*@/, "@"),
    delivered_to: to,
    subject,
    body_text_excerpt: subject,
    codes,
    links,
    dkim: "pass",
    dmarc: "pass",
    auth_failed: false,
    has_attachment: false,
    attachments: [],
    parse_status: "parsed",
    received_at: new Date().toISOString(),
  });
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

/** The API's error body, with the request id in the body and in X-Request-Id, as lib/errors.ts sends it. */
function apiError(res, status, type, code, message, param = null, extra = {}, headers = {}) {
  const requestId = `req_stub_${++seq}`;
  send(res, status, { error: { type, code, message, param, request_id: requestId, ...extra } }, { "X-Request-Id": requestId, ...headers });
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Stub sign-up</title></head>
<body>
  <form id="signup"><label>Email <input name="email" type="email" required></label><button type="submit">Sign up</button></form>
  <form id="verify" hidden><label>Code <input name="code"></label><button type="submit">Verify</button></form>
  <p role="status"></p>
  <script>
    let email = "";
    const result = document.querySelector("[role=status]");
    document.getElementById("signup").addEventListener("submit", async (e) => {
      e.preventDefault();
      email = e.target.email.value;
      const r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      if (r.ok) { document.getElementById("verify").hidden = false; result.textContent = "Check your email for a code"; }
    });
    document.getElementById("verify").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: e.target.code.value }) });
      result.textContent = (await r.json()).verified ? "Your account is verified" : "Wrong code";
    });
  </script>
</body></html>`;

async function waitRoute(req, res, url) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${KEY}`) {
    return apiError(res, 401, "authentication_error", auth ? "invalid_api_key" : "missing_authorization", auth ? "Invalid API key" : "Missing Authorization header");
  }
  const has = url.searchParams.get("has")?.trim() || null;
  if (has !== null && has !== "code" && has !== "link") {
    return apiError(res, 400, "invalid_request_error", "invalid_param_value", `has must be "code" or "link". Received: ${JSON.stringify(has)}.`, "has");
  }
  const rawTimeout = url.searchParams.get("timeout");
  const timeout = rawTimeout === null || rawTimeout.trim() === "" ? 30 : Number(rawTimeout);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 50) {
    return apiError(res, 400, "invalid_request_error", "invalid_param_value", `timeout must be a whole number of seconds from 0 to 50. Received: ${JSON.stringify(rawTimeout)}.`, "timeout");
  }
  const rawSince = url.searchParams.get("since")?.trim() || null;
  const since = rawSince === null ? Date.now() - 5 * 60_000 : Date.parse(rawSince);
  if (Number.isNaN(since)) {
    return apiError(res, 400, "invalid_request_error", "invalid_param_value", `since must be an ISO 8601 time. Received: ${JSON.stringify(rawSince)}.`, "since");
  }
  const to = url.searchParams.get("to")?.trim().toLowerCase().replace(/ /g, "+") || null;
  const from = url.searchParams.get("from")?.trim().toLowerCase() || null;
  const tag = to ? tagOf(to) : "";
  const record = { timeout, has, since: rawSince, status: 0 };
  if (to) calls.set(to, [...(calls.get(to) ?? []), record]);

  if (tag.startsWith("hang")) return; // never answers
  if (tag.startsWith("forbidden")) {
    record.status = 403;
    return apiError(res, 403, "permission_error", "insufficient_scope", "This API key does not have the read scope.");
  }
  if (tag.startsWith("planlimit")) {
    record.status = 402;
    return apiError(
      res,
      402,
      "payment_error",
      "plan_limit_exceeded",
      `Mail to ${to} arrived but was not kept: your plan keeps mail sent to 20 different plus addresses a day, and ${to} would have been one more. Upgrade, or reuse a plus address that already received mail today.`,
      "to",
      { upgrade_url: "https://app.mails.ai/billing" }
    );
  }
  if (tag.startsWith("limited") && calls.get(to).length === 1) {
    record.status = 429;
    return apiError(
      res,
      429,
      "rate_limit_error",
      "rate_limit_exceeded",
      "At most 60 waits a minute for one workspace.",
      null,
      { resets_at: new Date(Date.now() + 1000).toISOString(), retry_after_seconds: 1 },
      { "Retry-After": "1" }
    );
  }

  const matches = (m) =>
    (!to || m.delivered_to === to) &&
    (!from || (from.includes("@") ? m.from.address === from : m.from.address.endsWith(`@${from}`) || m.from.address.endsWith(`.${from}`))) &&
    (has !== "code" || m.codes.length > 0) &&
    (has !== "link" || m.links.some((l) => ACTION.includes(l.kind))) &&
    Date.parse(m.received_at) >= since;
  const holdMs = (tag.startsWith("fast") ? timeout / 50 : timeout) * 1000;
  const deadline = Date.now() + holdMs;
  for (;;) {
    const hit = [...messages].reverse().find(matches);
    if (hit) {
      record.status = 200;
      return send(res, 200, { message: hit, timed_out: false }, { "X-Request-Id": `req_stub_${++seq}` });
    }
    if (Date.now() >= deadline || res.destroyed) break;
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  record.status = 200;
  return send(res, 200, { message: null, timed_out: true }, { "X-Request-Id": `req_stub_${++seq}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE);
    if (req.method === "GET" && url.pathname === "/api/v1/messages/received/wait") return await waitRoute(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/signup") {
      const { email } = await readJson(req);
      const address = String(email).trim().toLowerCase();
      const [local, domain] = address.split("@");
      const state = {
        code: String(randomInt(100000, 1000000)),
        token: randomBytes(8).toString("hex"),
        decoyAddress: `${local.split("+")[0]}+decoy-${randomBytes(3).toString("hex")}@${domain}`,
        decoyCode: "",
        decoyToken: randomBytes(8).toString("hex"),
      };
      do state.decoyCode = String(randomInt(100000, 1000000));
      while (state.decoyCode === state.code);
      signups.set(address, state);
      // The decoy arrives first: a wait without `to` would take its code.
      setTimeout(() => deliver(state.decoyAddress, { codes: [{ value: state.decoyCode }], links: [{ url: `${ORIGIN}/verify?token=${state.decoyToken}`, kind: "verify" }] }), 600);
      setTimeout(
        () =>
          deliver(address, {
            codes: [{ value: state.code }],
            links: [
              { url: `${ORIGIN}/unsubscribe?u=${state.token}`, kind: "unsubscribe" },
              { url: `${ORIGIN}/help`, kind: "other" },
              { url: `${ORIGIN}/verify?token=${state.token}`, kind: "verify" },
            ],
            subject: "Confirm your email",
          }),
        1200
      );
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/verify") {
      const { email, code } = await readJson(req);
      const state = signups.get(String(email).trim().toLowerCase());
      return send(res, 200, { verified: Boolean(state && code === state.code) });
    }
    if (req.method === "GET" && url.pathname === "/verify") {
      const token = url.searchParams.get("token");
      const entry = [...signups].find(([, s]) => s.token === token);
      return send(res, entry ? 200 : 404, `<!doctype html><title>Verify</title><p role="status">${entry ? `Email verified for ${entry[0]}` : "Unknown link"}</p>`);
    }
    if (req.method === "GET" && url.pathname === "/test/state") return send(res, 200, signups.get(url.searchParams.get("email")) ?? {});
    if (req.method === "GET" && url.pathname === "/test/calls") return send(res, 200, calls.get(url.searchParams.get("to")) ?? []);
    if (req.method === "POST" && url.pathname === "/test/deliver") {
      const { to, delayMs = 0, ...rest } = await readJson(req);
      setTimeout(() => deliver(String(to).toLowerCase(), rest), delayMs);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`stub listening on ${ORIGIN}`));
