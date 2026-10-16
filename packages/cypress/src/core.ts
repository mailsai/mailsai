// @mailsai/cypress, the part with no Cypress in it: the plus address, the settings, the wait
// request, reading its answer, picking the code or the link, and spending a command's timeout as
// waits the API allows. index.ts turns these into Cypress commands; test/ runs them under node:test.
//
// The API side is GET /v1/messages/received/wait (app/api/v1/messages/received/wait/route.ts): it
// holds for up to 50 seconds and answers 200 `{ message, timed_out }`, with `message` null when
// nothing matched in time, and 429 past 60 waits a minute for one workspace.

/** Where the API is when MAILS_BASE_URL is not set. */
export const DEFAULT_BASE_URL = "https://api.mails.ai";
/** The longest one wait call may hold, in seconds: the route's own limit. */
export const MAX_WAIT_SECONDS = 50;
/** A wait command's whole timeout when none is given, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** How much longer than the wait it asked for one request may take, in seconds. */
export const REQUEST_GRACE_SECONDS = 15;
/** The longest pause after a 429 before the next try, in seconds. The route's limit counts a
 *  minute, so it never asks for more. */
export const MAX_RETRY_PAUSE_SECONDS = 60;

export type LinkKind = "verify" | "sign_in" | "reset_password" | "unsubscribe" | "other";
/** The kinds mailsaiWaitForLink can be asked for: every kind but `unsubscribe`, which it never yields. */
export type MailsaiLinkKind = Exclude<LinkKind, "unsubscribe">;
/** The links that are the point of an email: what `has=link` matches on the API, and what
 *  mailsaiWaitForLink yields when no kind is given. */
export const ACTION_LINK_KINDS: readonly LinkKind[] = ["verify", "sign_in", "reset_password"];
const WANTED_KINDS: readonly MailsaiLinkKind[] = ["verify", "sign_in", "reset_password", "other"];

/** A file on a received message, as @mailsai/sdk types it. */
export type MailsaiReceivedAttachment = {
  /** Attachment id (`att_…`), unique within the message. */
  id: string;
  /** The file's name, cleaned: no path, no control characters, at most 255 characters. */
  filename: string;
  /** The MIME type the sender declared, e.g. `application/pdf`. */
  content_type: string;
  /** Size in bytes of the decoded file. */
  size: number;
  /** The part's Content-ID without angle brackets, which the HTML body references as `cid:`. */
  content_id: string | null;
  /** True for an image embedded in the HTML body rather than attached as a file. */
  inline: boolean;
};

/** A file the message carried that was not kept, with the reason. */
export type MailsaiOmittedAttachment = {
  filename: string;
  content_type: string;
  size: number | null;
  reason: "too_large" | "budget" | "over_quota" | "unavailable" | "too_many";
};

/** A received message, as @mailsai/sdk types it (its `ReceivedMessage`). */
export type MailsaiReceivedMessage = {
  id: string;
  agent_id: string;
  thread_id?: string;
  /** The first mailbox of the From header. Proven only when `dmarc` is "pass". */
  from: { address: string; name?: string };
  /** The envelope sender (SMTP MAIL FROM), where bounces go. Null on mail received before this field was added. */
  envelope_from?: string | null;
  to: string;
  /** The address the email was sent to: the agent's receiving address, or a plus address of it.
   *  What the `to` filter matches. Null on mail received before 2026-10-16. */
  delivered_to?: string | null;
  subject?: string;
  is_thread_reply?: boolean;
  in_reply_to_message_id?: string;
  thread_root_message_id?: string;
  /** Full body: single-message `get` only. */
  body_text?: string;
  /** The HTML part: single-message `get` only, when the injection scan read it. */
  body_html?: string;
  extracted_text?: string;
  extracted_html?: string;
  body_text_excerpt?: string;
  /** Verification codes in the email (sign-up, sign-in, one-time), most likely first, at most 5. */
  codes?: { value: string }[];
  /** The email's links, `verify`, `sign_in` and `reset_password` first, `unsubscribe` last, at most 25. */
  links?: { url: string; kind: LinkKind }[];
  spf_pass?: boolean;
  dkim_pass?: boolean;
  dkim?: "pass" | "fail" | "none" | "unknown";
  /** The domain of a passing DKIM signature that matches the domain of `from.address`, or null. */
  dkim_domain?: string | null;
  /** "pass" when the domain of `from.address` publishes DMARC and a DKIM signature aligned with it verifies. */
  dmarc?: "pass" | "fail" | "none" | "unknown";
  /** True when the sender was judged forged. */
  auth_failed?: boolean;
  /** True when the message carries at least one file attachment (embedded images do not count). */
  has_attachment?: boolean;
  /** Every part of the message that is a file, embedded images included. */
  attachments?: MailsaiReceivedAttachment[];
  attachments_omitted?: MailsaiOmittedAttachment[];
  attachments_omitted_count?: number;
  /** Present when the raw email was not kept, and why. */
  raw_omitted?: "too_large" | "budget" | "over_quota" | "unavailable";
  parse_status?: "parsed" | "quarantined" | "pending" | "failed" | "quota_skipped";
  received_at: string;
  created_at?: string;
};

export type MailsaiWaitOptions = {
  /** Only mail sent to this address, such as the plus address the test signed up with. */
  to?: string;
  /** Only mail from this address, or from this domain and its subdomains. */
  from?: string;
  /** Only mail with a verification code, or with a verify, sign-in or password-reset link. */
  has?: "code" | "link";
  /** Only mail received at or after this time (ISO 8601). Without it the API looks back 5 minutes. */
  since?: string;
  /** Seconds to wait in all, 60 by default. Spent as waits of at most 50 seconds each. */
  timeout?: number;
  /** Only this agent's mail. MAILS_AGENT_ID by default. */
  agentId?: string;
};
export type MailsaiWaitForCodeOptions = Omit<MailsaiWaitOptions, "has">;
export type MailsaiWaitForLinkOptions = Omit<MailsaiWaitOptions, "has"> & {
  /** The kind of link to yield. Without it: the first verify, sign_in or reset_password link. */
  kind?: MailsaiLinkKind;
};

export type WaitCommand = "mailsaiWaitForMessage" | "mailsaiWaitForCode" | "mailsaiWaitForLink";

// ── settings ────────────────────────────────────────────────────────────────────────────────

/** The settings the commands read, from the `env` block of the Cypress config or CYPRESS_* variables. */
export const CONFIG_KEYS = ["MAILS_API_KEY", "MAILS_RECEIVING_ADDRESS", "MAILS_BASE_URL", "MAILS_AGENT_ID"] as const;

export type MailsaiConfig = { apiKey: string; receivingAddress: string; baseUrl: string; agentId: string };

function setting(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** The settings as the commands use them: trimmed, and "" for one that is unset. */
export function configFrom(env: Record<string, unknown>): MailsaiConfig {
  return {
    apiKey: setting(env.MAILS_API_KEY),
    receivingAddress: setting(env.MAILS_RECEIVING_ADDRESS),
    baseUrl: setting(env.MAILS_BASE_URL),
    agentId: setting(env.MAILS_AGENT_ID),
  };
}

/** The error a command fails with when a setting it needs is unset. */
export function missingSetting(command: string, key: "MAILS_API_KEY" | "MAILS_RECEIVING_ADDRESS"): Error {
  const what =
    key === "MAILS_API_KEY"
      ? "a mails.ai API key with the read scope"
      : "the receiving address of the mails.ai agent the test mail goes to, such as qa.acme@in.mails.ai";
  return new Error(
    `${command} needs ${key}: ${what}. Set it in the env block of cypress.config.ts (env: { ${key}: process.env.${key} }) or as the environment variable CYPRESS_${key}.`
  );
}

/** The API's address: MAILS_BASE_URL without its trailing slashes, or https://api.mails.ai when it
 *  is empty, as in @mailsai/sdk. */
export function baseUrlOf(raw: string): string {
  const base = (raw.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]/i.test(base)) {
    throw new Error(`MAILS_BASE_URL must be an http:// or https:// address, such as ${DEFAULT_BASE_URL}. Received: ${JSON.stringify(raw)}`);
  }
  return base;
}

// ── plus addresses ──────────────────────────────────────────────────────────────────────────

/** The most characters the part of an address before the @ may hold: RFC 5321's limit, and what
 *  the API's `to` filter takes. A receiving address that already has 64 leaves no room for a tag. */
export const MAX_LOCAL_PART = 64;
/** The most characters a tag may have. */
export const MAX_TAG = 40;
/** The fewest random characters a shortened default tag may have and still be unique to its run. */
export const MIN_UNIQUE_TAG = 6;

/** `s` without leading and trailing ASCII whitespace (space, tab, CR, LF), as the Python SDK trims a tag. */
function trimAscii(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

/** The part of the receiving address before its @, cut at its first `+`. */
function baseLocalPart(receivingAddress: string, at: number): string {
  return receivingAddress.slice(0, at).split("+")[0];
}

/**
 * A plus address of an agent: its receiving address with `+<tag>` before the `@`, which reaches the
 * same agent. The same rules as `plusAddress()` in @mailsai/sdk: the tag is trimmed of ASCII
 * whitespace and lowercased and must be 1 to 40 letters, digits, `.`, `_`, `-` or `+`; only the part
 * of the local part before its first `+` is kept, and with the tag it may hold at most 64
 * characters; the whole address is lowercased.
 */
export function plusAddress(receivingAddress: string, tag: string): string {
  const at = receivingAddress.lastIndexOf("@");
  if (at < 1) throw new Error(`Not an address: ${JSON.stringify(receivingAddress)}`);
  const t = trimAscii(tag).toLowerCase();
  if (!/^[a-z0-9._+-]{1,40}$/.test(t)) throw new Error(`A tag is 1 to 40 letters, digits, ".", "_", "-" or "+". Received: ${JSON.stringify(tag)}`);
  const local = baseLocalPart(receivingAddress, at);
  if (local.length + 1 + t.length > MAX_LOCAL_PART) {
    const room = MAX_LOCAL_PART - local.length - 1;
    throw new Error(
      room < 1
        ? `${receivingAddress} has no room for a tag: the part of an address before the @ holds at most ${MAX_LOCAL_PART} characters, and it already has ${local.length}.`
        : `The part of an address before the @ holds at most ${MAX_LOCAL_PART} characters, so a tag on ${receivingAddress} can have at most ${room}. Received ${t.length}: ${JSON.stringify(tag)}`
    );
  }
  return `${local}+${t}@${receivingAddress.slice(at + 1)}`.toLowerCase();
}

/** How many characters a tag on `receivingAddress` may have: 40, or fewer when the part before its
 *  @ leaves less room under MAX_LOCAL_PART (0 or less: none). */
export function tagRoom(receivingAddress: string): number {
  const at = receivingAddress.lastIndexOf("@");
  const local = at < 1 ? "" : baseLocalPart(receivingAddress, at);
  return Math.min(MAX_TAG, MAX_LOCAL_PART - local.length - 1);
}

const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => TAG_ALPHABET[b % TAG_ALPHABET.length]).join("");
}

/**
 * A tag for one run: `run-`, the time in base 36 and 4 random letters or digits, such as
 * `run-mgt2k4x1-7q3z` (17 characters). When `room` (tagRoom()) is less than that, as many random
 * characters as fit, which keep the tag unique while at least MIN_UNIQUE_TAG fit; with fewer, the
 * full tag, which plusAddress() then refuses, naming the room there is.
 */
export function defaultTag(now: number = Date.now(), random: (n: number) => string = randomChars, room: number = MAX_TAG): string {
  const time = now.toString(36);
  if (`run-${time}-xxxx`.length <= room || room < MIN_UNIQUE_TAG) return `run-${time}-${random(4)}`;
  return random(room);
}

/** The address mailsaiPlusAddress yields: plusAddress() with the tag given, or with a new default
 *  tag per call that fits the receiving address. */
export function plusAddressFor(
  receivingAddress: string,
  tag: unknown,
  now: number = Date.now(),
  random: (n: number) => string = randomChars
): string {
  if (tag === undefined || tag === null) return plusAddress(receivingAddress, defaultTag(now, random, tagRoom(receivingAddress)));
  if (typeof tag !== "string") throw new TypeError(`mailsaiPlusAddress takes a tag that is a string, or nothing. Received: ${describe(tag)}`);
  return plusAddress(receivingAddress, tag);
}

// ── the wait ────────────────────────────────────────────────────────────────────────────────

/** A wait command's options, checked: the filters as the API takes them and the whole timeout. */
export type WaitPlan = {
  to?: string;
  from?: string;
  has?: "code" | "link";
  since?: string;
  agentId?: string;
  /** Whole seconds to wait in all. */
  timeout: number;
  /** mailsaiWaitForLink only: the kind of link to yield. */
  kind?: MailsaiLinkKind;
};

const OPTION_NAMES: Record<WaitCommand, readonly string[]> = {
  mailsaiWaitForMessage: ["to", "from", "has", "since", "timeout", "agentId"],
  mailsaiWaitForCode: ["to", "from", "since", "timeout", "agentId"],
  mailsaiWaitForLink: ["to", "from", "since", "timeout", "agentId", "kind"],
};

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v !== "object") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function stringOption(command: WaitCommand, name: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new TypeError(`${command}: ${name} must be a string. Received: ${describe(v)}`);
  const s = v.trim();
  // An empty filter is a mistake (an address that was never set), and leaving it out would widen
  // the wait to mail meant for another test run.
  if (!s) throw new TypeError(`${command}: ${name} is empty. Give a value, or leave ${name} out.`);
  return s;
}

function timeoutOf(command: WaitCommand, v: unknown): number {
  if (v === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new TypeError(`${command}: timeout is the seconds to wait in all, a number from 0 up. Received: ${describe(v)}`);
  }
  return Math.ceil(v);
}

/** A wait command's options, checked: an unknown option, an empty filter or a bad timeout throws,
 *  and mailsaiWaitForCode and mailsaiWaitForLink set `has` themselves. */
export function waitPlan(command: WaitCommand, input: unknown): WaitPlan {
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== "object" || Array.isArray(given)) {
    throw new TypeError(`${command} takes an options object, such as { to: email }. Received: ${describe(input)}`);
  }
  const o = given as Record<string, unknown>;
  const names = OPTION_NAMES[command];
  for (const key of Object.keys(o)) {
    if (o[key] !== undefined && !names.includes(key)) throw new TypeError(`${command} has no option "${key}". Its options are ${names.join(", ")}.`);
  }
  const plan: WaitPlan = { timeout: timeoutOf(command, o.timeout) };
  for (const key of ["to", "from", "since", "agentId"] as const) {
    const v = stringOption(command, key, o[key]);
    if (v !== undefined) plan[key] = v;
  }
  if (command === "mailsaiWaitForCode") plan.has = "code";
  else if (command === "mailsaiWaitForLink") {
    plan.has = "link";
    if (o.kind !== undefined) {
      if (!WANTED_KINDS.includes(o.kind as MailsaiLinkKind)) {
        throw new TypeError(`${command}: kind must be one of ${WANTED_KINDS.map((k) => `"${k}"`).join(", ")}. Received: ${describe(o.kind)}`);
      }
      plan.kind = o.kind as MailsaiLinkKind;
    }
  } else if (o.has !== undefined) {
    if (o.has !== "code" && o.has !== "link") throw new TypeError(`${command}: has must be "code" or "link". Received: ${describe(o.has)}`);
    plan.has = o.has;
  }
  return plan;
}

/** The filters, as the Command Log line and the errors show them. */
export function describeFilters(plan: WaitPlan): string {
  const parts: string[] = [];
  if (plan.to) parts.push(`to: ${plan.to}`);
  if (plan.from) parts.push(`from: ${plan.from}`);
  if (plan.has) parts.push(`has: ${plan.has}`);
  if (plan.kind) parts.push(`kind: ${plan.kind}`);
  if (plan.since) parts.push(`since: ${plan.since}`);
  if (plan.agentId) parts.push(`agent: ${plan.agentId}`);
  return parts.length ? parts.join(", ") : "any received mail";
}

/** The seconds the next wait call asks for: what is left of the timeout, at most 50. */
export function nextWaitSeconds(left: number): number {
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, left));
}

/** How a timeout is spent when nothing arrives: 60 → [50, 10], 120 → [50, 50, 20], 0 → [0]. */
export function splitTimeout(total: number): number[] {
  const parts = [nextWaitSeconds(total)];
  for (let left = total - parts[0]; left > 0; left -= parts[parts.length - 1]) parts.push(nextWaitSeconds(left));
  return parts;
}

export type WaitRequest = { method: "GET"; url: string; headers: Record<string, string>; timeout: number };

/** One call to GET /v1/messages/received/wait asking to hold for `seconds`. `timeout` is how long
 *  Cypress gives the request, in milliseconds: the wait and REQUEST_GRACE_SECONDS more. `since` is
 *  sent only when given, so the API's own look-back applies. */
export function waitRequest(baseUrl: string, apiKey: string, plan: WaitPlan, seconds: number): WaitRequest {
  const qs = new URLSearchParams();
  if (plan.agentId) qs.set("agent_id", plan.agentId);
  if (plan.from) qs.set("from", plan.from);
  if (plan.to) qs.set("to", plan.to);
  if (plan.since) qs.set("since", plan.since);
  if (plan.has) qs.set("has", plan.has);
  qs.set("timeout", String(seconds));
  return {
    method: "GET",
    url: `${baseUrlOf(baseUrl)}/api/v1/messages/received/wait?${qs.toString()}`,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    timeout: (seconds + REQUEST_GRACE_SECONDS) * 1000,
  };
}

// ── the answer ──────────────────────────────────────────────────────────────────────────────

/** The API's error body (lib/errors.ts), as read from a refused call. */
export type ApiErrorDetails = {
  status: number;
  type: string;
  code: string;
  message: string;
  param: string | null;
  requestId: string | null;
  /** Where to change plan: the `upgrade_url` every 402 (payment_error) carries, such as a wait
   *  for mail the plan's daily plus-address limit refused. Null otherwise. */
  upgradeUrl: string | null;
};

export type WaitAnswer =
  | { kind: "message"; message: MailsaiReceivedMessage }
  | { kind: "timed_out" }
  | {
      kind: "rate_limited";
      error: ApiErrorDetails;
      /** Seconds until the limit lets a wait through, from Retry-After or the body's
       *  retry_after_seconds; null when the answer did not say. */
      retryAfterSeconds: number | null;
      /** False when the body's resets_at is null: no wait lifts the limit. */
      waitHelps: boolean;
    }
  | { kind: "error"; error: ApiErrorDetails };

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  }
  return null;
}

/** `Retry-After` in seconds: a number of seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, (at - now) / 1000);
}

function asObject(body: unknown): Record<string, unknown> | null {
  let b = body;
  // cy.request parses a JSON body only when the answer says it is JSON.
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b !== null && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** What one wait call's answer means: a message, nothing in time, a 429, or an error. */
export function readWaitResponse(status: number, body: unknown, headers?: Headers): WaitAnswer {
  const b = asObject(body);
  if (status >= 200 && status < 300) {
    if (b && b.message !== null && typeof b.message === "object" && !Array.isArray(b.message)) {
      return { kind: "message", message: b.message as MailsaiReceivedMessage };
    }
    if (b && b.message === null) return { kind: "timed_out" };
    return {
      kind: "error",
      error: {
        status,
        type: "api_error",
        code: "unexpected_response",
        message: "The answer was not a mails.ai wait result ({ message, timed_out }). Is MAILS_BASE_URL the API's address?",
        param: null,
        requestId: null,
        upgradeUrl: null,
      },
    };
  }
  const e = b && b.error !== null && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
  const error: ApiErrorDetails = {
    status,
    type: str(e?.type) ?? (status === 429 ? "rate_limit_error" : "api_error"),
    code: str(e?.code) ?? "unknown",
    message: str(e?.message) ?? `The API answered ${status} without a mails.ai error body. Is MAILS_BASE_URL the API's address?`,
    param: str(e?.param),
    requestId: str(e?.request_id) ?? header(headers, "x-request-id"),
    upgradeUrl: str(e?.upgrade_url),
  };
  if (status !== 429) return { kind: "error", error };
  const fromHeader = parseRetryAfter(header(headers, "retry-after"));
  const fromBody = typeof e?.retry_after_seconds === "number" && Number.isFinite(e.retry_after_seconds) ? e.retry_after_seconds : null;
  return { kind: "rate_limited", error, retryAfterSeconds: fromHeader ?? fromBody, waitHelps: !(e && e.resets_at === null) };
}

/** Whole seconds to pause after a 429 before trying again: what the answer asked for, else 1, 2,
 *  4 then 8 for 429s in a row (`times` is how many came before this one), at most
 *  MAX_RETRY_PAUSE_SECONDS. Null when no wait lifts the limit. */
export function retryPause(answer: { retryAfterSeconds: number | null; waitHelps: boolean }, times: number): number | null {
  if (!answer.waitHelps) return null;
  const s = answer.retryAfterSeconds ?? Math.min(8, 2 ** times);
  return Math.min(MAX_RETRY_PAUSE_SECONDS, Math.max(1, Math.ceil(s)));
}

/** The error of a refused wait, carrying the API's code and message, and on a 402 ending with the
 *  link to change plan, so a failed CI run says where to go. */
export class MailsaiApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly upgradeUrl: string | null;
  constructor(command: string, e: ApiErrorDetails, extra = "") {
    const upgrade = e.upgradeUrl ? ` Change your plan: ${e.upgradeUrl}` : "";
    super(`${command}: mails.ai answered ${e.status} ${e.code}: ${e.message}${extra}${upgrade}${e.requestId ? ` (request ${e.requestId})` : ""}`);
    this.name = "MailsaiApiError";
    this.status = e.status;
    this.type = e.type;
    this.code = e.code;
    this.param = e.param;
    this.requestId = e.requestId;
    this.upgradeUrl = e.upgradeUrl ?? null;
  }
}

/** The error of a 429 the rest of the timeout cannot wait out. */
export function rateLimitError(command: string, e: ApiErrorDetails, pause: number | null, left: number, timeout: number): MailsaiApiError {
  const why =
    pause === null
      ? " Waiting does not lift this limit."
      : ` Waiting for it takes ${pause} s, more than the ${left} s left of this command's ${timeout} s timeout.`;
  return new MailsaiApiError(command, e, why);
}

/** The error when nothing matching arrived within the timeout. */
export function noMailError(command: string, plan: WaitPlan): Error {
  return new Error(`${command}: no email arrived within ${plan.timeout} s matching ${describeFilters(plan)}.`);
}

/** Where a wait stands: `left` is the seconds of its timeout not yet spent, `limited` how many 429s
 *  in a row came before the next call. A wait starts at { left: timeout, limited: 0 }. */
export type PollState = { left: number; limited: number };

export type PollStep =
  | { do: "yield"; message: MailsaiReceivedMessage }
  | { do: "call"; state: PollState }
  | { do: "pause"; seconds: number; state: PollState }
  | { do: "fail"; error: Error };

/**
 * What a wait does after the answer to a call that asked to hold for `seconds`: yield the message,
 * make the next call while time is left (a timeout of 60 is a 50 s call, then a 10 s one), pause
 * after a 429 for as long as it asks when the rest of the timeout covers the pause, or fail.
 */
export function afterAnswer(command: WaitCommand, plan: WaitPlan, state: PollState, seconds: number, answer: WaitAnswer): PollStep {
  switch (answer.kind) {
    case "message":
      return { do: "yield", message: answer.message };
    case "timed_out": {
      const left = state.left - seconds;
      return left > 0 ? { do: "call", state: { left, limited: 0 } } : { do: "fail", error: noMailError(command, plan) };
    }
    case "rate_limited": {
      const pause = retryPause(answer, state.limited);
      if (pause === null || pause > state.left) return { do: "fail", error: rateLimitError(command, answer.error, pause, state.left, plan.timeout) };
      return { do: "pause", seconds: pause, state: { left: state.left - pause, limited: state.limited + 1 } };
    }
    case "error":
      return { do: "fail", error: new MailsaiApiError(command, answer.error) };
  }
}

// ── what the commands yield ─────────────────────────────────────────────────────────────────

/** The message, as the Command Log and the errors name it. */
export function messageLabel(message: MailsaiReceivedMessage): string {
  return message.subject ? `${message.id} ("${message.subject}")` : String(message.id);
}

/** The code mailsaiWaitForCode yields: `codes[0].value`, or null when there is none. */
export function codeOf(message: MailsaiReceivedMessage): string | null {
  const first = Array.isArray(message.codes) ? message.codes[0] : undefined;
  return first && typeof first.value === "string" && first.value ? first.value : null;
}

/** The link mailsaiWaitForLink yields: the first of `kind`, or without one the first verify,
 *  sign_in or reset_password link. Never an unsubscribe link; null when none fits. */
export function linkOf(message: MailsaiReceivedMessage, kind?: MailsaiLinkKind): string | null {
  const links = Array.isArray(message.links) ? message.links : [];
  const hit = links.find(
    (l) =>
      l !== null &&
      typeof l === "object" &&
      typeof l.url === "string" &&
      l.url !== "" &&
      l.kind !== "unsubscribe" &&
      (kind ? l.kind === kind : ACTION_LINK_KINDS.includes(l.kind))
  );
  return hit ? hit.url : null;
}

/** The error when the message mailsaiWaitForCode got has no code. */
export function noCodeError(command: string, message: MailsaiReceivedMessage): Error {
  return new Error(`${command}: the email ${messageLabel(message)} has no code.`);
}

/** The error when the message mailsaiWaitForLink got has no link it may yield, naming the kinds it has. */
export function noLinkError(command: string, message: MailsaiReceivedMessage, kind?: MailsaiLinkKind): Error {
  const wanted = kind ? `link of kind "${kind}"` : "verify, sign_in or reset_password link";
  const counts = new Map<string, number>();
  for (const l of Array.isArray(message.links) ? message.links : []) counts.set(String(l?.kind), (counts.get(String(l?.kind)) ?? 0) + 1);
  const has = counts.size ? ` Its links: ${[...counts].map(([k, n]) => `${k} (${n})`).join(", ")}.` : " It has no links.";
  return new Error(`${command}: the email ${messageLabel(message)} has no ${wanted}.${has}`);
}
