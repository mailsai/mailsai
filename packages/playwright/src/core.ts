// @mailsai/playwright, the part with no Playwright in it: the settings, the plus address, a wait's
// options, reading what @mailsai/sdk answers, picking the code or the link, and spending a wait's
// timeout as waits the API allows. client.ts makes the calls; index.ts is the Playwright fixture;
// test/ runs these under node:test.
//
// Modelled on @mailsai/cypress (packages/cypress/src/core.ts) so the two behave the same: the same
// plus addresses, the same options, the same time budget and the same failure messages, under the
// names mails.address(), mails.waitForMessage(), mails.waitForCode() and mails.waitForLink().
//
// The API side is GET /v1/messages/received/wait (app/api/v1/messages/received/wait/route.ts): it
// holds for up to 50 seconds and answers 200 `{ message, timed_out }`, with `message` null when
// nothing matched in time, and 429 past 60 waits a minute for one workspace. @mailsai/sdk makes
// the call (`received.wait`) and throws a MailsError for any answer that is not a 2xx.

import { randomBytes } from "node:crypto";
import { MailsError, plusAddress, type ReceivedMessage } from "@mailsai/sdk";

/** Where the API is when neither the baseUrl option nor MAILS_BASE_URL is set. */
export const DEFAULT_BASE_URL = "https://api.mails.ai";
/** The longest one wait call may hold, in seconds: the route's own limit. */
export const MAX_WAIT_SECONDS = 50;
/** A wait's whole timeout when none is given, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** How much longer than the wait it asked for one request may take, in seconds. */
export const REQUEST_GRACE_SECONDS = 15;
/** The longest pause after a 429 before the next try, in seconds. The route's limit counts a
 *  minute, so it never asks for more. */
export const MAX_RETRY_PAUSE_SECONDS = 60;

export type LinkKind = "verify" | "sign_in" | "reset_password" | "unsubscribe" | "other";
/** The kinds waitForLink can be asked for: every kind but `unsubscribe`, which it never returns. */
export type MailsaiLinkKind = Exclude<LinkKind, "unsubscribe">;
/** The links that are the point of an email: what `has=link` matches on the API, and what
 *  waitForLink returns when no kind is given. */
export const ACTION_LINK_KINDS: readonly LinkKind[] = ["verify", "sign_in", "reset_password"];
const WANTED_KINDS: readonly MailsaiLinkKind[] = ["verify", "sign_in", "reset_password", "other"];

/** A received message, as @mailsai/sdk types it (its `ReceivedMessage`). */
export type MailsaiReceivedMessage = ReceivedMessage;

export type MailsaiWaitOptions = {
  /** Only mail sent to this address. Defaults to the last address `mails.address()` made. */
  to?: string;
  /** Only mail from this address, or from this domain and its subdomains. */
  from?: string;
  /** Only mail with a verification code, or with a verify, sign-in or password-reset link. */
  has?: "code" | "link";
  /** Only mail received at or after this time (ISO 8601, or a Date). Without it the API looks back 5 minutes. */
  since?: string | Date;
  /** Seconds to wait in all, 60 by default. Spent as waits of at most 50 seconds each. */
  timeout?: number;
  /** Only this agent's mail. The agentId setting (MAILS_AGENT_ID) by default. */
  agentId?: string;
};
export type MailsaiWaitForCodeOptions = Omit<MailsaiWaitOptions, "has">;
export type MailsaiWaitForLinkOptions = Omit<MailsaiWaitOptions, "has"> & {
  /** The kind of link to return. Without it: the first verify, sign_in or reset_password link. */
  kind?: MailsaiLinkKind;
};

export type WaitCommand = "mails.waitForMessage" | "mails.waitForCode" | "mails.waitForLink";

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v !== "object") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

// ── settings ────────────────────────────────────────────────────────────────────────────────

/** The options of mailsFixtures() and createMails(). Each setting left out is read from its
 *  environment variable when it is needed. */
export type MailsOptions = {
  /** A mails.ai API key with the read scope. MAILS_API_KEY by default. */
  apiKey?: string;
  /** The receiving address of the agent the test mail goes to, such as qa.acme@in.mails.ai.
   *  MAILS_RECEIVING_ADDRESS by default. */
  receivingAddress?: string;
  /** The API's address. MAILS_BASE_URL by default, then https://api.mails.ai. */
  baseUrl?: string;
  /** The waits' agentId when they are not given one. MAILS_AGENT_ID by default. */
  agentId?: string;
  /** The fetch the requests are made with. The global fetch by default. */
  fetch?: typeof fetch;
};

export const OPTION_KEYS = ["apiKey", "receivingAddress", "baseUrl", "agentId", "fetch"] as const;

/** The options, checked: an unknown option or one of the wrong type throws, naming it. The value
 *  of `apiKey` is never put in a message. */
export function checkOptions(fn: string, input: unknown): MailsOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${fn} takes an options object, such as { receivingAddress: "qa.acme@in.mails.ai" }, or nothing.`);
  }
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (o[key] !== undefined && !(OPTION_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`${fn} has no option "${key}". Its options are ${OPTION_KEYS.join(", ")}.`);
    }
  }
  for (const key of ["apiKey", "receivingAddress", "baseUrl", "agentId"] as const) {
    if (o[key] !== undefined && typeof o[key] !== "string") {
      throw new TypeError(`${fn}: ${key} must be a string.${key === "apiKey" ? "" : ` Received: ${describe(o[key])}`}`);
    }
  }
  if (o.fetch !== undefined && typeof o.fetch !== "function") throw new TypeError(`${fn}: fetch must be a function.`);
  return { ...(o as MailsOptions) };
}

export type MailsSettings = { apiKey: string; receivingAddress: string; baseUrl: string; agentId: string };

function setting(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The settings as the methods use them: each option, else its environment variable, trimmed;
 *  "" for one that is unset. An empty option counts as unset, as in @mailsai/sdk. */
export function settingsFrom(options: MailsOptions, env: Record<string, string | undefined>): MailsSettings {
  return {
    apiKey: setting(options.apiKey) || setting(env.MAILS_API_KEY),
    receivingAddress: setting(options.receivingAddress) || setting(env.MAILS_RECEIVING_ADDRESS),
    baseUrl: setting(options.baseUrl) || setting(env.MAILS_BASE_URL),
    agentId: setting(options.agentId) || setting(env.MAILS_AGENT_ID),
  };
}

/** The error a method fails with when a setting it needs is unset. */
export function missingSetting(command: string, key: "MAILS_API_KEY" | "MAILS_RECEIVING_ADDRESS"): Error {
  const [what, option] =
    key === "MAILS_API_KEY"
      ? ["a mails.ai API key with the read scope", "apiKey"]
      : ["the receiving address of the mails.ai agent the test mail goes to, such as qa.acme@in.mails.ai", "receivingAddress"];
  return new Error(`${command} needs ${key}: ${what}. Set the environment variable ${key} where the tests run, or pass ${option} to mailsFixtures() or createMails().`);
}

/** The API's address: the baseUrl setting without its trailing slashes, or https://api.mails.ai
 *  when it is empty, as in @mailsai/sdk. */
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
/** The fewest random characters a shortened default tag may have and still be unique to its test. */
export const MIN_UNIQUE_TAG = 6;

/** The part of the receiving address before its @, cut at its first `+`. */
function baseLocalPart(receivingAddress: string, at: number): string {
  return receivingAddress.slice(0, at).split("+")[0];
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
  return Array.from(randomBytes(n), (b) => TAG_ALPHABET[b % TAG_ALPHABET.length]).join("");
}

/**
 * A tag for one test: `run-`, the time in base 36 and 4 random letters or digits, such as
 * `run-mgt2k4x1-7q3z` (17 characters), as @mailsai/cypress makes. When `room` (tagRoom()) is less
 * than that, as many random characters as fit, which keep the tag unique while at least
 * MIN_UNIQUE_TAG fit; with fewer, the full tag, which plusAddress() then refuses, naming the room.
 */
export function defaultTag(now: number = Date.now(), random: (n: number) => string = randomChars, room: number = MAX_TAG): string {
  const time = now.toString(36);
  if (`run-${time}-xxxx`.length <= room || room < MIN_UNIQUE_TAG) return `run-${time}-${random(4)}`;
  return random(room);
}

/**
 * The address mails.address() returns: plusAddress() of @mailsai/sdk with the tag given, or with a
 * new default tag per call that fits the receiving address. plusAddress() trims the tag of ASCII
 * whitespace and lowercases it, takes 1 to 40 letters, digits, `.`, `_`, `-` or `+`, keeps the
 * receiving address's local part up to its first `+`, and refuses a tag that would take the part
 * before the @ past 64 characters, naming the room there is.
 */
export function plusAddressFor(
  receivingAddress: string,
  tag: unknown,
  now: number = Date.now(),
  random: (n: number) => string = randomChars
): string {
  if (tag === undefined || tag === null) return plusAddress(receivingAddress, defaultTag(now, random, tagRoom(receivingAddress)));
  if (typeof tag !== "string") throw new TypeError(`mails.address takes a tag that is a string, or nothing. Received: ${describe(tag)}`);
  return plusAddress(receivingAddress, tag);
}

// ── the wait ────────────────────────────────────────────────────────────────────────────────

/** A wait's options, checked: the filters as the API takes them and the whole timeout. */
export type WaitPlan = {
  to?: string;
  from?: string;
  has?: "code" | "link";
  /** ISO 8601, as given, or a Date's toISOString(). */
  since?: string;
  agentId?: string;
  /** Whole seconds to wait in all. */
  timeout: number;
  /** waitForLink only: the kind of link to return. */
  kind?: MailsaiLinkKind;
};

const OPTION_NAMES: Record<WaitCommand, readonly string[]> = {
  "mails.waitForMessage": ["to", "from", "has", "since", "timeout", "agentId"],
  "mails.waitForCode": ["to", "from", "since", "timeout", "agentId"],
  "mails.waitForLink": ["to", "from", "since", "timeout", "agentId", "kind"],
};

function stringOption(command: WaitCommand, name: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new TypeError(`${command}: ${name} must be a string. Received: ${describe(v)}`);
  const s = v.trim();
  // An empty filter is a mistake (an address that was never set), and leaving it out would widen
  // the wait to mail meant for another test.
  if (!s) throw new TypeError(`${command}: ${name} is empty. Give a value, or leave ${name} out.`);
  return s;
}

function sinceOption(command: WaitCommand, v: unknown): string | undefined {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError(`${command}: since is a Date that is not a valid time.`);
    return v.toISOString();
  }
  if (v !== undefined && typeof v !== "string") {
    throw new TypeError(`${command}: since must be an ISO 8601 time, such as 2026-10-20T09:30:00Z, or a Date. Received: ${describe(v)}`);
  }
  return stringOption(command, "since", v);
}

function timeoutOf(command: WaitCommand, v: unknown): number {
  if (v === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new TypeError(`${command}: timeout is the seconds to wait in all, a number from 0 up. Received: ${describe(v)}`);
  }
  return Math.ceil(v);
}

/** A wait's options, checked: an unknown option, an empty filter or a bad timeout throws, and
 *  waitForCode and waitForLink set `has` themselves. */
export function waitPlan(command: WaitCommand, input: unknown): WaitPlan {
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== "object" || Array.isArray(given) || given instanceof Date) {
    throw new TypeError(`${command} takes an options object, such as { to: email }. Received: ${describe(input)}`);
  }
  const o = given as Record<string, unknown>;
  const names = OPTION_NAMES[command];
  for (const key of Object.keys(o)) {
    if (o[key] !== undefined && !names.includes(key)) throw new TypeError(`${command} has no option "${key}". Its options are ${names.join(", ")}.`);
  }
  const plan: WaitPlan = { timeout: timeoutOf(command, o.timeout) };
  for (const key of ["to", "from", "agentId"] as const) {
    const v = stringOption(command, key, o[key]);
    if (v !== undefined) plan[key] = v;
  }
  const since = sinceOption(command, o.since);
  if (since !== undefined) plan.since = since;
  if (command === "mails.waitForCode") plan.has = "code";
  else if (command === "mails.waitForLink") {
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

/** The filters, as the step title and the errors show them. */
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

// ── the answer ──────────────────────────────────────────────────────────────────────────────

/** A refused call, as the API's error body (lib/errors.ts) says it. */
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

function unexpectedResponse(status: number): WaitAnswer {
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

/** What a call that @mailsai/sdk answered means: a message, nothing in time, or (for a 2xx that is
 *  not a wait result, such as a web page at a wrong MAILS_BASE_URL) an error. */
export function answerFromResult(result: unknown, status: number): WaitAnswer {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const m = (result as { message?: unknown }).message;
    if (m !== null && typeof m === "object" && !Array.isArray(m)) return { kind: "message", message: m as MailsaiReceivedMessage };
    if (m === null) return { kind: "timed_out" };
  }
  return unexpectedResponse(status);
}

// What @mailsai/sdk adds to the API's message: on a 402, the link to change plan (MailsaiApiError
// puts it back, last, as @mailsai/cypress does); on a 429 it did not wait out, when the limit
// resets (this package waits out a 429 itself, within the wait's timeout, and says so in its own
// words); and, for an answer with no mails.ai error body, "<METHOD> <path> failed with <status>".
const SDK_RESET_SUFFIX = / It resets in \d+ s \(at [^)]*\): longer than this client waits on its own \(\d+ s\)\.$/;
const SDK_NO_BODY = /^[A-Z]+ \/\S* failed with \d+$/;

/** The API's own message, from a MailsError of @mailsai/sdk. */
export function apiMessage(err: MailsError): string {
  let m = err.message;
  if (err.upgradeUrl) {
    const link = ` Change your plan: ${err.upgradeUrl}`;
    if (m.endsWith(link)) m = m.slice(0, -link.length);
  }
  m = m.replace(SDK_RESET_SUFFIX, "");
  if (err.code === "unknown" && SDK_NO_BODY.test(m)) {
    m = `The API answered ${err.status} without a mails.ai error body. Is MAILS_BASE_URL the API's address?`;
  }
  return m;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * What a call that threw means, when it threw because of what the API answered: a MailsError of
 * @mailsai/sdk (any answer that was not a 2xx; a RateLimitError for a 429), or a SyntaxError (a
 * 2xx whose body is not JSON). `status` is the status of the last answer, when there was one.
 * Null for anything else, such as a network failure or the request's deadline, which the caller
 * reports itself.
 */
export function answerFromError(err: unknown, status: number | null): WaitAnswer | null {
  if (err instanceof MailsError) {
    const error: ApiErrorDetails = {
      status: err.status,
      type: str(err.type) ?? (err.status === 429 ? "rate_limit_error" : "api_error"),
      code: str(err.code) ?? "unknown",
      message: apiMessage(err),
      param: str(err.param),
      requestId: str(err.requestId),
      upgradeUrl: str(err.upgradeUrl),
    };
    if (err.status !== 429) return { kind: "error", error };
    const after = typeof err.retryAfterSeconds === "number" && Number.isFinite(err.retryAfterSeconds) ? err.retryAfterSeconds : null;
    return { kind: "rate_limited", error, retryAfterSeconds: after, waitHelps: err.resetsAt !== null };
  }
  if (err instanceof SyntaxError) return unexpectedResponse(status ?? 200);
  return null;
}

/** Whole seconds to pause after a 429 before trying again: what the answer asked for, else 1, 2,
 *  4 then 8 for 429s in a row (`times` is how many came before this one), at most
 *  MAX_RETRY_PAUSE_SECONDS. Null when no wait lifts the limit. */
export function retryPause(answer: { retryAfterSeconds: number | null; waitHelps: boolean }, times: number): number | null {
  if (!answer.waitHelps) return null;
  const s = answer.retryAfterSeconds ?? Math.min(8, 2 ** times);
  return Math.min(MAX_RETRY_PAUSE_SECONDS, Math.max(1, Math.ceil(s)));
}

/** The error of a refused wait: a MailsError of @mailsai/sdk whose message carries the method, the
 *  API's status, code and message, and on a 402 ends with the link to change plan, so a failed CI
 *  run says where to go. */
export class MailsaiApiError extends MailsError {
  constructor(command: string, e: ApiErrorDetails, extra = "") {
    const upgrade = e.upgradeUrl ? ` Change your plan: ${e.upgradeUrl}` : "";
    super({
      type: e.type,
      code: e.code,
      status: e.status,
      message: `${command}: mails.ai answered ${e.status} ${e.code}: ${e.message}${extra}${upgrade}${e.requestId ? ` (request ${e.requestId})` : ""}`,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.param ? { param: e.param } : {}),
      ...(e.upgradeUrl ? { upgradeUrl: e.upgradeUrl } : {}),
    });
    this.name = "MailsaiApiError";
  }
}

/** The error of a 429 the rest of the timeout cannot wait out. */
export function rateLimitError(command: string, e: ApiErrorDetails, pause: number | null, left: number, timeout: number): MailsaiApiError {
  const why =
    pause === null
      ? " Waiting does not lift this limit."
      : ` Waiting for it takes ${pause} s, more than the ${left} s left of this wait's ${timeout} s timeout.`;
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
  | { do: "return"; message: MailsaiReceivedMessage }
  | { do: "call"; state: PollState }
  | { do: "pause"; seconds: number; state: PollState }
  | { do: "fail"; error: Error };

/**
 * What a wait does after the answer to a call that asked to hold for `seconds`: return the
 * message, make the next call while time is left (a timeout of 60 is a 50 s call, then a 10 s
 * one), pause after a 429 for as long as it asks when the rest of the timeout covers the pause,
 * or fail.
 */
export function afterAnswer(command: WaitCommand, plan: WaitPlan, state: PollState, seconds: number, answer: WaitAnswer): PollStep {
  switch (answer.kind) {
    case "message":
      return { do: "return", message: answer.message };
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

// ── what the methods return ─────────────────────────────────────────────────────────────────

/** The message, as the errors name it. */
export function messageLabel(message: MailsaiReceivedMessage): string {
  return message.subject ? `${message.id} ("${message.subject}")` : String(message.id);
}

/** The code waitForCode returns: `codes[0].value`, or null when there is none. */
export function codeOf(message: MailsaiReceivedMessage): string | null {
  const first = Array.isArray(message.codes) ? message.codes[0] : undefined;
  return first && typeof first.value === "string" && first.value ? first.value : null;
}

/** The link waitForLink returns: the first of `kind`, or without one the first verify, sign_in or
 *  reset_password link. Never an unsubscribe link; null when none fits. */
export function linkOf(message: MailsaiReceivedMessage, kind?: MailsaiLinkKind): string | null {
  const links: unknown[] = Array.isArray(message.links) ? message.links : [];
  for (const l of links) {
    if (l === null || typeof l !== "object") continue;
    const { url, kind: k } = l as { url?: unknown; kind?: unknown };
    if (typeof url !== "string" || url === "" || k === "unsubscribe") continue;
    if (kind ? k === kind : ACTION_LINK_KINDS.includes(k as LinkKind)) return url;
  }
  return null;
}

/** The error when the message waitForCode got has no code. */
export function noCodeError(command: string, message: MailsaiReceivedMessage): Error {
  return new Error(`${command}: the email ${messageLabel(message)} has no code.`);
}

/** The error when the message waitForLink got has no link it may return, naming the kinds it has. */
export function noLinkError(command: string, message: MailsaiReceivedMessage, kind?: MailsaiLinkKind): Error {
  const wanted = kind ? `link of kind "${kind}"` : "verify, sign_in or reset_password link";
  const counts = new Map<string, number>();
  for (const l of Array.isArray(message.links) ? message.links : []) counts.set(String(l?.kind), (counts.get(String(l?.kind)) ?? 0) + 1);
  const has = counts.size ? ` Its links: ${[...counts].map(([k, n]) => `${k} (${n})`).join(", ")}.` : " It has no links.";
  return new Error(`${command}: the email ${messageLabel(message)} has no ${wanted}.${has}`);
}
