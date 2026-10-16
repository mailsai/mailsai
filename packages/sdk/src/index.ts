// @mailsai/sdk — TypeScript client for the Mails.ai API.
// 6 lines to give an AI agent a working email primitive:
//
//   import { mails } from "@mailsai/sdk";
//   const sarah = mails.agent("sarah");
//   await sarah.send({ to: "user@example.com", subject: "Your receipt", body: "Order 10473 is paid." });

import crypto from "crypto";

export type ClientOptions = {
  /** Defaults to MAILS_API_KEY. An empty value counts as unset. */
  apiKey?: string;
  /** Defaults to MAILS_BASE_URL, then https://api.mails.ai. An empty value counts as unset. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** The longest the client waits on its own before retrying a rate-limited (429) or
   *  retry-safe 5xx response, in seconds: 60 by default and at most 60 (a larger value counts
   *  as 60). A shorter wait the server asks for is slept and the call retried. A longer one, or
   *  a limit that waiting does not lift, throws at once: a {@link RateLimitError} for a 429,
   *  carrying when the limit resets (`resetsAt`) and how long that is (`retryAfterSeconds`). */
  maxRetryWaitSeconds?: number;
};

export type Tag = { name: string; value: string };

/**
 * A file to send: its bytes (`content_base64`, with `content_type`), or an https `path` that
 * mails.ai downloads when it sends, not both. A `path` must answer within 10 seconds after at
 * most 3 redirects, each to https, and never at a private, loopback or link-local address; a
 * file that cannot be fetched refuses the send with 400 `invalid_field` naming it
 * (`attachments.0.path`). Up to 10 files and 25 MB in all, fetched files included.
 *
 * With `content_id` the file is shown inside the HTML instead of attached:
 * `<img src="cid:logo">` shows the file whose `content_id` is `"logo"`.
 */
export type Attachment = {
  filename: string;
  /** Shown inside `body_html` where it says `cid:<content_id>`. Letters, digits and
   *  `. _ - @ + = $`, up to 127 characters, unique within the message. */
  content_id?: string;
} & (
  | { content_base64: string; content_type: string; path?: never }
  | {
      /** An https URL mails.ai fetches at send time. */
      path: string;
      /** Optional with `path`: the type the URL answers with is used. */
      content_type?: string;
      content_base64?: never;
    }
);

export type SendInput = {
  /** The agent to send as. OPTIONAL since 0.1.2 — omit it and the workspace's single
   *  agent is used, or, with a key that holds `manage`, one is created on the spot (named
   *  from `from`). Only needed when
   *  a workspace has SEVERAL agents and you must say which. When it is given it decides the
   *  sender: a `from` beside it picks no agent and creates none. */
  agent?: string;
  /** The sender you want — a handle or an address. `"billing"`, `"billing@acme.com"` and
   *  `"Acme <billing@acme.com>"` all mean the agent called `billing`.
   *
   *  It SELECTS that agent: resolved if it exists, created if it doesn't and the key holds
   *  `manage`, refused with 403 `insufficient_scope` if the key does not, and with 402
   *  `plan_limit_exceeded` if your plan has no room for another one. It is never
   *  resolved to a DIFFERENT agent — read `SendResult.from` for the address that actually
   *  sent. Beside an explicit `agent` it selects nothing: `agent` decides the sender.
   *
   *  It cannot spoof a sender: the From address is always the agent's own. A display name in
   *  it (`Acme` in `"Acme <billing@acme.com>"`) does go on the From line, beside an `agent`
   *  too, and on a scheduled send as well.
   *  Lets you write the same call you'd write for any email API. */
  from?: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  body_text?: string;
  body_html?: string;
  reply_to?: string;
  in_reply_to_message_id?: string;
  /** RFC Message-IDs to stitch this message into an existing thread (References header). */
  references?: string[];
  /** Up to 10 files, 25 MB in all: each by its bytes or by an https `path`, and shown inside
   *  the HTML when it has a `content_id` (see {@link Attachment}). Files given as bytes travel
   *  inside the request, so together they can come to about 3 MB; give a larger one by `path`. */
  attachments?: Attachment[];
  metadata?: Record<string, string>;
  /** @deprecated The API ignores it: it decides how each message is sent. Kept so code that sets
   *  it still compiles. */
  pool_hint?: "clean" | "mixed";
  scheduled_at?: string;
  tags?: Tag[];
  /** Opt in to RFC 8058 one-click unsubscribe (`List-Unsubscribe` +
   *  `List-Unsubscribe-Post` headers), so the recipient's mail app shows an Unsubscribe
   *  button. One click suppresses the address for your WHOLE workspace: every later send
   *  to it is refused with `recipient_suppressed` until you allowlist it. Use it for
   *  newsletters and digests; leave it off (the default) for password resets, sign-in
   *  links and receipts. Needs exactly one `to` recipient and no `cc` / `bcc`. */
  list_unsubscribe?: boolean;
  idempotency_key?: string;
};

/** A file a send carried, as the API describes it (the bytes are not kept). */
export type SentAttachment = {
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Only on a file shown inside the HTML: the id its `cid:` names. */
  content_id?: string;
};

export type SendResult = {
  id: string;
  agent_id: string;
  /**
   * The agent address this was actually sent as — the resolved `from`.
   *
   * Worth reading when you pass `from` as a naming hint rather than an explicit `agent`:
   * it is the receipt for which identity the API picked. Returned by send, list and get
   * alike. On a verified custom domain the message goes out from this exact address. On the
   * shared mails.ai domain it goes out from `<name>.<workspace>@send.mails.ai`, and replies
   * come back through `<name>.<workspace>@in.mails.ai`.
   */
  from?: string;
  thread_id?: string;
  /** The message this one answers: the one replied to or forwarded, or the
   *  `in_reply_to_message_id` the send set. On a reply's answer and from `messages.get()`, when
   *  set. */
  in_reply_to_message_id?: string;
  /** The message a forward came from: on a forward's answer only. */
  forwarded_from?: string;
  to: string[];
  /** Cc recipients. Always on a reply's answer (`[]` when none); from `messages.list()` and
   *  `messages.get()`, when there are any. */
  cc?: string[];
  /** Bcc recipients. Only from `messages.list()` and `messages.get()`, when there are any. */
  bcc?: string[];
  /** The recipients the email service refused while it took the message for the others: it went
   *  to everyone else, and not to these. Still a send: a retry with the same idempotency key gives
   *  this answer back and sends nothing. Present only when there were any. */
  refused_recipients?: string[];
  subject: string;
  /** The plain-text body as sent; on a forward it includes the quoted original. Only from
   *  `messages.get()`, when there is one. */
  body_text?: string;
  /** The HTML body as sent. Only from `messages.get()`, when there is one. */
  body_html?: string;
  /** The `References` chain kept with the message: the `references` the send passed, or on a
   *  reply the ids of the earlier messages it answers. Only from `messages.get()`, when there is
   *  one. */
  references?: string[];
  /** The `metadata` the send passed; a scheduled send refused when it came due also carries
   *  `rejected_reason` and `rejected_at`. Only from `messages.get()`, when there is any. */
  metadata?: Record<string, string>;
  /** @deprecated Not part of the documented API: a sent message carries it only for
   *  compatibility, so code that reads it keeps running. Do not build on it. */
  routing_pool: "clean" | "mixed" | "outbound";
  classifier_score: number;
  /** A send answers `sent`, `scheduled`, or `delivered` when delivery to every recipient was
   *  confirmed at once (with a live key, a send only to the test address reply@test.mails.ai,
   *  or a sending route that confirms in its own answer; a test key's sends answer `sent`).
   *  Read back later it can also be `sending`, `delayed` (a transient bounce: the receiving
   *  server has not taken it yet, and it may still be delivered), `bounced`, `complained`,
   *  `rejected` or `canceled`. The API never returns `queued`; it stays for code written
   *  against earlier versions. */
  status: "queued" | "scheduled" | "sending" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "rejected" | "canceled";
  cost_usd: number;
  /** The sending provider's id for the message, which its delivery, bounce and complaint reports
   *  refer to; `test-<message id>` for a test-mode send. Only from `messages.list()` and
   *  `messages.get()`, once the message has been handed off. */
  ses_message_id?: string;
  scheduled_at?: string;
  /** When the message was handed off for sending: at once for an immediate send, when it came due
   *  for a scheduled one. Only from `messages.list()` and `messages.get()`, once that happened. */
  sent_at?: string;
  /** When delivery was confirmed; with several recipients, the time of the latest report. Only
   *  from `messages.list()` and `messages.get()`, once a delivery is confirmed. */
  delivered_at?: string;
  /** When the scheduled send was canceled. Only from `messages.list()` and `messages.get()`, for a
   *  canceled message. */
  canceled_at?: string;
  /** When a bounce was last reported; a soft bounce, which marks it `delayed`, does not set it.
   *  Only from `messages.get()`. */
  bounced_at?: string;
  /** When a recipient's complaint about the message was last reported. Only from
   *  `messages.get()`. */
  complained_at?: string;
  /** The files it carried: name, type and size, and the content_id of one shown inside the HTML. */
  attachments?: SentAttachment[];
  tags?: Tag[];
  /** True when this rode a test key: the full request path ran and nothing was transmitted. */
  test_mode?: boolean;
  /**
   * TEST MODE ONLY. Present when the outbound firewall judged this message cold or bulk —
   * i.e. **this exact message would be refused with `422 cold_email_prohibited` on a live
   * key**. Test mode returns the verdict on a 201 instead of throwing, so a sandbox first
   * send can succeed and you can check a message before you send it for real.
   *
   * Check it. A test send that returns `status: "sent"` with this field set is not a
   * message that will go out.
   */
  classifier_warning?: {
    code: "cold_email_prohibited";
    /** Human-readable: what fired, what passes, and where the policy is. */
    message: string;
    /** 0-1 cold confidence. */
    score: number;
    /** e.g. "cold_outreach" | "bulk_marketing" | "spam" | "unclear" */
    reason: string;
  };
  created_at: string;
};

export type ReplyInput = {
  body?: string;
  body_text?: string;
  body_html?: string;
  reply_all?: boolean;
  cc?: string[];
  bcc?: string[];
  tags?: Tag[];
  scheduled_at?: string;
  /** One-click unsubscribe, as on {@link SendInput.list_unsubscribe}. Off by default. */
  list_unsubscribe?: boolean;
  /** Sent as the `Idempotency-Key` header, as on {@link SendInput.idempotency_key}: a retry
   *  with the same key returns the first reply instead of sending a second one. */
  idempotency_key?: string;
};

export type ForwardInput = {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
  /** One-click unsubscribe, as on {@link SendInput.list_unsubscribe}. Off by default. */
  list_unsubscribe?: boolean;
  /** Sent as the `Idempotency-Key` header, as on {@link SendInput.idempotency_key}. */
  idempotency_key?: string;
};

export type ListResult<T> = { data: T[]; has_more: boolean; next_cursor?: string };

/**
 * How an inbound message's sender was authenticated, checked from the email itself and never
 * from a header in it. In `data` on `message.received`, `reply.received` and
 * `message.received.unauthenticated`.
 */
export type InboundAuthentication = {
  /** `pass`, `fail`, `none` (the email is not signed) or `unknown` (it could not be checked). */
  dkim?: "pass" | "fail" | "none" | "unknown";
  /** The domain of the passing DKIM signature that matches the From domain, or null. */
  dkim_domain?: string | null;
  /** `pass` when a DKIM signature aligned with the From domain verifies, `none` when that domain
   *  publishes no DMARC record, otherwise `unknown`: `fail` is not reported while SPF cannot be
   *  checked. */
  dmarc?: "pass" | "fail" | "none" | "unknown";
  /** `unknown` while the sending server's address is not known (mail reaches us through Cloudflare). */
  spf?: "pass" | "fail" | "unknown";
  /** True on `message.received.unauthenticated`: the forged-sender case. */
  auth_failed?: boolean;
  /** The same verdicts as true, false or null (not known). */
  spf_pass?: boolean | null;
  dkim_pass?: boolean | null;
  /** The email's ARC chain as we checked it: `none` when it has none, `unknown` when it could not
   *  be checked. It is what vouches for mail forwarded to the agent (forwarding mode). */
  arc?: "pass" | "fail" | "none" | "unknown";
  /** The mail service whose ARC seal, on a chain that validates, reports that DMARC passed for
   *  the From domain when the mail reached it; null when none did. Such mail never raises
   *  `message.received.unauthenticated`, while `dkim`, `dkim_domain` and `dmarc` still say only
   *  what we verified ourselves. */
  trusted_forwarder?: "google_workspace" | "microsoft_365" | "fastmail" | "zoho" | null;
};

/** Who an inbound email is from, as an inbound event's `data` carries it. */
export type InboundSender = {
  /** The first mailbox of the email's From header, the one the checks in
   *  {@link InboundAuthentication} are about. It is proven only when `dmarc` is `pass`. Replies
   *  go to the Reply-To or to this address. `name` is its display name, or null when it has
   *  none; `message.received.over_limit` carries the address only. */
  from?: { address: string; name?: string | null };
  /** The envelope sender (SMTP MAIL FROM), where bounces go: often a sending service's own bounce
   *  address, never where a reply goes. Null when it is not known, as on a simulated email
   *  (`POST /v1/test/inbound`). */
  envelope_from?: string | null;
};

/** The three event types of mail an agent received. */
export type InboundEventType = "message.received" | "reply.received" | "message.received.unauthenticated";

/**
 * The `data` of an inbound event. These fields are on each one, so a handler reads
 * `event.data.from.address` with no check first. `from` is who the From header says sent the
 * email, which only `dmarc: "pass"` proves.
 */
export type InboundEventData = TypedEvent["data"] & {
  /** `name` is the display name beside the address, or null. */
  from: { address: string; name: string | null };
  /** The email's subject; null when it has none. */
  subject: string | null;
  /** When the message reached us (UTC), not the email's own Date header. */
  received_at: string;
  /** The first 500 characters of the plain-text body. */
  body_text_excerpt: string;
  /** The plain-text body with quoted history stripped; null when nothing is left. */
  extracted_text: string | null;
  /** The HTML part with quoted history stripped; null when there is none, or when the injection
   *  scan did not read the message. */
  extracted_html: string | null;
  /** Path to the message as an .eml file. */
  raw_url: string;
  /** The kinds of injection the scan found; empty when it found none. `auth_fail` marks a sender
   *  that failed authentication, and `scan_unavailable` a scan that could not run. */
  injection_categories: string[];
  auth_failed: boolean;
  spf_pass: boolean | null;
  dkim_pass: boolean | null;
};

/** An inbound event. `agent.onMessage`, `agent.onReply`, `listMessages()` and `listReplies()`
 *  give these, and {@link isInboundEvent} picks them out of any other event, such as a verified
 *  webhook's. */
export type InboundEvent = Omit<TypedEvent, "type" | "data"> & { type: InboundEventType; data: InboundEventData };

const INBOUND_EVENT_TYPES: readonly string[] = ["message.received", "reply.received", "message.received.unauthenticated"] satisfies InboundEventType[];

/** True for an inbound event, whose `data` then has the fields of {@link InboundEventData}. */
export function isInboundEvent(event: TypedEvent): event is InboundEvent {
  return INBOUND_EVENT_TYPES.includes(event.type);
}

export type TypedEvent = {
  id: string;
  /**
   * Event type. Inbound: `reply.received` (a genuine reply to one of your sends),
   * `message.received` (a first-contact inbound — NOT a reply — whose sender was not judged
   * forged, which does not mean it was authenticated),
   * `message.received.unauthenticated` (a forged sender: no DKIM signature aligned with
   * the From domain verifies, and that domain's DMARC policy is quarantine or reject), and
   * `message.received.over_limit` (mail received while the workspace was over a limit; it
   * carries no subject or body). How the sender was authenticated is in `data`
   * ({@link InboundAuthentication}). Outbound lifecycle: `message.sent` /
   * `message.delivered` / `message.delayed` (a transient bounce; the message may still be
   * delivered) / `message.bounced` / `message.complained` / `message.scheduled` /
   * `message.failed` (a scheduled send that ended without going out). Drafts:
   * `draft.scheduled` / `draft.sending` / `draft.sent` / `draft.failed`. Also
   * `suppression.added`, `webhook.test`, and `thread.created` / `thread.updated` /
   * `thread.deleted` (a `"*"` webhook gets neither the thread events nor `message.delayed`
   * unless it names them). Use `agent.onReply` for replies and `agent.onMessage` for cold
   * inbound.
   */
  type: string;
  workspace_id: string;
  agent_id?: string;
  source_message_id?: string;
  intent?: string;
  urgency?: number;
  injection_score?: number;
  sender_reputation?: number;
  /**
   * The firewall's VERDICT on an inbound message: `true` when it crossed our quarantine
   * threshold. `injection_score` is the evidence. Quarantine is the floor, not the whole
   * check: an agent that acts on mail should also hold, for a person, mail with no score
   * (it was not scanned) and anything scored 0.5 or more. A scan that could not run scores
   * exactly 0.5.
   *
   * ```ts
   * agent.onMessage((e) => {
   *   if (e.quarantined || typeof e.injection_score !== "number" || e.injection_score >= 0.5) return hold(e);
   *   act(e);
   * });
   * ```
   *
   * Inbound events only (`message.received`, `reply.received`); `undefined` on outbound
   * lifecycle events.
   */
  quarantined?: boolean;
  entities?: Record<string, unknown>;
  /** The thread the message behind the event belongs to (`thrd_…`), when it has one. */
  thread_id?: string;
  test_mode: boolean;
  /** The event's payload, which varies by type. Inbound events carry the sender
   *  ({@link InboundSender}) and how it was authenticated ({@link InboundAuthentication}). */
  data: Record<string, unknown> & InboundSender & InboundAuthentication;
  created_at: string | null;
};

export type AgentRow = {
  id: string;
  name: string;
  email: string;
  domain: string;
  /** Where this agent receives mail, and every send's Reply-To unless the send sets
   *  `reply_to`: `<name>.<slug>@in.mails.ai`, or `billing.example_com@in.mails.ai` for an
   *  agent on your own domain. Give this address to whoever should write to the agent. */
  receiving_address: string;
  workspace_id: string;
  status: "active" | "paused" | "archived";
  pause_reason?: string;
  daily_send_limit?: number;
  hourly_send_limit?: number;
  allowlist_domains?: string[];
  blocklist_domains?: string[];
  classify_inbound?: boolean;
  /** Unread threads in the agent's inbox folder. */
  unread_count?: number;
  /** Forwarding mode, for an agent at an address on the workspace's own domain: the mail
   *  service that already hosts that address forwards its mail to `forwarding_address`. */
  forwarding?: boolean;
  /** Where that mail service forwards to. null while forwarding is off. */
  forwarding_address?: string | null;
  /** `verified` once a test (`agents.verifyForwarding`) came back through the forward,
   *  `failing` while the last test is 15 minutes late, null while forwarding is off. */
  forwarding_status?: "not_verified" | "verified" | "failing" | null;
  forwarding_test_sent_at?: string | null;
  forwarding_verified_at?: string | null;
  created_at: string | null;
  updated_at?: string | null;
};

/** The settings an agent can be created with (`agents.create`). */
export type AgentCreateOptions = {
  domain?: string;
  allowlist_domains?: string[];
  blocklist_domains?: string[];
  daily_send_limit?: number;
  hourly_send_limit?: number;
  /**
   * Also read this agent's new mail for intent (never a reply in a thread), so its
   * `message.received` events (`agent.onMessage`) can carry an `intent`, `entities` and
   * `urgency`. Off unless set. On `reply.received` (`agent.onReply`) the `intent` is always
   * `general_reply`. Turning it on needs a paid plan (402 `feature_not_enabled`); the
   * injection scan runs either way.
   */
  classify_inbound?: boolean;
};

/** Where a thread is filed. `sent` is assigned, never chosen: it holds a thread whose
 *  messages are all ones the agent sent, until a reply moves it to the inbox. */
export type ThreadFolder = "inbox" | "archive" | "spam" | "trash" | "sent";

export type ThreadRow = {
  id: string;
  agent_id: string;
  subject?: string;
  root_message_id?: string;
  last_message_id?: string;
  last_message_at?: string;
  message_count: number;
  participants: string[];
  /** Label names. Any string works; names that match a label object also appear in `label_ids`. */
  labels: string[];
  /** Ids (`lbl_…`) of the label objects whose names are on this thread. */
  label_ids?: string[];
  status: "open" | "closed" | "archived";
  /** False once new mail arrives. */
  read?: boolean;
  folder?: ThreadFolder;
  /** When the thread was moved to trash; present only while it is there. Trash is emptied
   *  30 days after a thread reaches it. */
  trashed_at?: string;
  /** True when the thread holds no live mail: every message in it was sent with a test key or
   *  delivered through `POST /v1/test/inbound`. A live key cannot reply to its test messages
   *  (403 `test_mode_required`). */
  test_mode: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type ThreadDetail = ThreadRow & {
  messages: Array<
    | {
        id: string;
        direction: "outbound";
        to: string[];
        subject: string;
        snippet: string;
        status: string;
        sent_at?: string;
        scheduled_at?: string;
        created_at: string | null;
      }
    | {
        id: string;
        direction: "inbound";
        from: string;
        to: string;
        subject?: string;
        extracted_text?: string;
        body_text_excerpt?: string;
        snippet: string;
        received_at: string;
        is_thread_reply?: boolean;
        has_attachment?: boolean;
        attachments?: ReceivedAttachment[];
        created_at: string | null;
      }
  >;
};

/** A file on a received message. Download it with `received.attachments.download`. */
export type ReceivedAttachment = {
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
export type OmittedAttachment = {
  filename: string;
  content_type: string;
  size: number | null;
  reason: "too_large" | "budget" | "over_quota" | "unavailable" | "too_many";
};

export type ReceivedMessage = {
  id: string;
  agent_id: string;
  thread_id?: string;
  /** The first mailbox of the From header. Proven only when `dmarc` is "pass". */
  from: { address: string; name?: string };
  /** The envelope sender (SMTP MAIL FROM), where bounces go. Null on mail received before this field was added. */
  envelope_from?: string | null;
  to: string;
  /** The address the email was sent to: the agent's `receiving_address`, or a plus address of it
   *  (see {@link plusAddress}). What the `to` filter matches. Null on mail received before 2026-10-16. */
  delivered_to?: string | null;
  subject?: string;
  is_thread_reply?: boolean;
  in_reply_to_message_id?: string;
  thread_root_message_id?: string;
  /** Full body — single-message `get` only. */
  body_text?: string;
  /** The HTML part — single-message `get` only, when the injection scan read it. */
  body_html?: string;
  extracted_text?: string;
  extracted_html?: string;
  body_text_excerpt?: string;
  /** Verification codes in the email (sign-up, sign-in, one-time), most likely first, at most 5. */
  codes?: { value: string }[];
  /** The email's links, `verify`, `sign_in` and `reset_password` first, `unsubscribe` last, at most 25. */
  links?: { url: string; kind: "verify" | "sign_in" | "reset_password" | "unsubscribe" | "other" }[];
  spf_pass?: boolean;
  dkim_pass?: boolean;
  dkim?: "pass" | "fail" | "none" | "unknown";
  /** The domain of a passing DKIM signature that matches the domain of `from.address`, or null. */
  dkim_domain?: string | null;
  /** "pass" when the domain of `from.address` publishes DMARC and a DKIM signature aligned with it verifies. */
  dmarc?: "pass" | "fail" | "none" | "unknown";
  /** True when the sender was judged forged: the verdict behind `message.received.unauthenticated`. */
  auth_failed?: boolean;
  /** True when the message carries at least one file attachment (embedded images do not count). */
  has_attachment?: boolean;
  /** Every part of the message that is a file, embedded images included. */
  attachments?: ReceivedAttachment[];
  attachments_omitted?: OmittedAttachment[];
  attachments_omitted_count?: number;
  /** Present when the raw email was not kept, and why. */
  raw_omitted?: "too_large" | "budget" | "over_quota" | "unavailable";
  parse_status?: "parsed" | "quarantined" | "pending" | "failed" | "quota_skipped";
  received_at: string;
  created_at?: string;
};

export type DraftRow = {
  id: string;
  agent_id: string;
  to: string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  send_at?: string;
  /** Whether the draft is sent with one-click unsubscribe headers. */
  list_unsubscribe?: boolean;
  sent_message_id?: string;
  error_message?: string;
  tags?: Tag[];
  created_at: string | null;
  updated_at: string | null;
};

export type SuppressionLookup = {
  suppressed: boolean;
  type?: "hard_bounce" | "complaint" | "unsubscribe";
  scope?: string;
  since?: string;
  allowed?: { id: string; attestation: string; created_at: string };
};

export type ApiKeyRow = {
  id: string;
  prefix: string;
  name: string | null;
  mode: "live" | "test";
  scopes: string[];
  agent_id: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
};

/** An app connected to the workspace by signing in: the mails CLI, or an app such as Claude,
 *  ChatGPT or Cursor. */
export type ConnectedApp = {
  /** The sign-in's id (`oag_…`). */
  id: string;
  /** The app's OAuth client id. The mails CLI's is `https://api.mails.ai/oauth/clients/cli`. */
  client_id: string;
  client_name: string | null;
  /** True for the mails CLI. */
  first_party: boolean;
  /** What the person approved: `full_access`, `send` or `read`. */
  scope: string;
  /** What its tokens may do, in API key scopes. */
  scopes: ("send" | "read" | "manage")[];
  created_at: string;
  approved_at: string;
  last_used_at: string | null;
  /** API keys it created that still work. Revoking the app leaves them working. */
  created_api_keys: number;
  /** Webhook endpoints it created. Revoking the app leaves them in place. */
  created_webhooks: number;
  /** Other webhook endpoints still signing with a secret it was shown: rotate them. */
  signing_secrets_known: number;
};

export type WebhookRow = {
  id: string;
  url: string;
  event_types: string[];
  description: string | null;
  active: boolean;
  /** When the signing secret was last rotated. */
  secret_rotated_at?: string | null;
  /** While set, deliveries are signed with both the new and the previous secret. */
  previous_secret_expires_at?: string | null;
  created_at: string | null;
};

/** The answer to `webhooks.rotateSecret`. `signing_secret` is shown once. */
export type WebhookSecretRotated = {
  id: string;
  signing_secret: string;
  secret_rotated_at: string;
  /** Until then every delivery also carries a signature from the previous secret, so a
   *  receiver can switch over without dropping events. */
  previous_secret_expires_at: string;
};

export type WebhookDelivery = {
  id: string;
  webhook_endpoint_id: string;
  event_id: string;
  attempt_number: number;
  status: "pending" | "succeeded" | "failed" | "dlq";
  http_status?: number;
  response_body_excerpt?: string;
  next_retry_at?: string;
  delivered_at?: string;
  created_at: string | null;
};

export type LogEntry = {
  id: string;
  category: string;
  action: string;
  target_resource_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string | null;
};

export type MeResult = {
  api_key: {
    id: string;
    prefix?: string;
    name: string | null;
    mode: "live" | "test";
    scopes: string[];
    agent_id: string | null;
    last_used_at: string | null;
    created_at: string | null;
  };
  workspace: { id: string; slug: string; display_name: string; tier: string; tier_status: string } | null;
  agent: { id: string; name: string; email: string } | null;
};

export type UsageResult = {
  workspace_id: string;
  tier: string;
  tier_status: string;
  period_start: string;
  period_end: string;
  usage: {
    sends: number;
    parses: number;
    /** Inbound messages kept but not classified, because the workspace was over its inbound quota. */
    inbound_skipped?: number;
    webhook_deliveries: number;
    sends_cost_usd: number;
    parses_cost_usd: number;
  };
  caps: {
    /** Null when the plan has no monthly limit (metered). */
    monthly_sends: number | null;
    monthly_parses: number | null;
    agents: number | "unlimited";
    hourly: number;
    daily: number;
    hourly_inbound?: number;
    daily_inbound?: number;
  };
};

/** GET /v1/reputation without an agent: the workspace's aggregate. */
export type ReputationWorkspace = {
  workspace_id: string;
  /** Aggregate reputation 0–1. */
  reputation: number;
  agents_count: number;
  last_computed_at?: string | null;
};

/** GET /v1/reputation for one agent: its score and its 30-day counts. */
export type ReputationAgent = {
  agent_id: string;
  reputation: number;
  send_count_30d?: number;
  bounce_count_30d?: number;
  complaint_count_30d?: number;
  reply_count_30d?: number;
};

/** What `reputation.get` returns: the workspace answer without an agent, the agent answer
 *  with one. Every field of both is here; the other shape's fields are absent. */
export type Reputation = Partial<ReputationWorkspace> & Partial<ReputationAgent> & { reputation: number };

/** The review outcome of `messages.appeal`. */
export type AppealResult = {
  outcome: "overturned" | "upheld" | "not_appealable" | "not_blocked";
  message: string;
  review_score?: number;
  reason?: string;
  replayed?: boolean;
};

export type AppealInput = {
  /** The agent the refused send used (name or id). Omit it for the workspace's single agent. */
  agent?: string;
  /** The refused message's subject, verbatim. */
  subject?: string;
  /** Alias of `body_text`, as on send. */
  body?: string;
  body_text?: string;
  body_html?: string;
};

/** Simulate an inbound email with a TEST key: real classifier, real event and webhooks. */
export type TestInboundInput = {
  /** Your agent, by name or id. */
  agent: string;
  /** Sender address. Required unless `raw_base64` is sent. */
  from?: string;
  from_name?: string;
  subject?: string;
  /** Message text. Required unless `raw_base64` is sent. */
  body_text?: string;
  /** A complete raw email (RFC 822), base64-encoded, up to 3 MB decoded. */
  raw_base64?: string;
  /** The `id` of an earlier test send, to simulate a reply to it (`reply.received`). */
  in_reply_to_message_id?: string;
  spf?: "pass" | "fail" | "unknown";
  dkim?: "pass" | "fail" | "unknown";
};

export type TestInboundResult = {
  message_id: string;
  thread_id: string;
  event_id: string;
  event_type: "message.received" | "reply.received" | "message.received.unauthenticated";
  quarantined: boolean;
  test_mode: boolean;
  has_attachment?: boolean;
  attachments?: ReceivedAttachment[];
  classification: {
    intent?: string;
    entities?: Record<string, unknown>;
    urgency?: number;
    injection_score: number;
    injection_categories?: string[];
    sender_reputation?: number;
    classifier_model?: string;
  };
};

/** `agents.inbox`: unread and thread counts per folder and per label for one agent. */
export type InboxSummary = {
  agent_id: string;
  email: string;
  /** Unread threads in the inbox folder. */
  unread_count: number;
  folders: Record<ThreadFolder, { threads: number; unread: number }>;
  labels: Array<{ id: string | null; name: string; color: string | null; threads: number; unread: number }>;
  last_message_at: string | null;
};

export type LabelColor =
  | "gray" | "red" | "orange" | "amber" | "yellow" | "green"
  | "teal" | "cyan" | "blue" | "indigo" | "purple" | "pink";

export type Label = {
  /** Label id (`lbl_…`). */
  id: string;
  /** Unique in the workspace, ignoring case. */
  name: string;
  color: LabelColor;
  created_at: string;
  updated_at: string;
};

export type SearchParams = {
  /** Words to find in subjects and bodies. Without it, the newest mail matching the filters. */
  q?: string;
  agent_id?: string;
  from?: string;
  to?: string;
  /** Only mail at or after this time: a Date, an ISO 8601 timestamp, or a plain date. */
  after?: string | Date;
  /** Only mail before this time: a Date, an ISO 8601 timestamp, or a plain date. */
  before?: string | Date;
  has_attachment?: boolean;
  /** One folder, or `all`. Without it: every folder except trash. */
  folder?: ThreadFolder | "all";
  label?: string;
  type?: "received" | "sent";
  limit?: number;
  cursor?: string;
};

export type SearchHit = {
  type: "received" | "sent";
  /** The message id (`rcv_…` or `msg_…`). */
  id: string;
  thread_id: string | null;
  agent_id: string;
  subject: string | null;
  from: { address: string; name: string | null };
  to: string[];
  /** Received time, or sent time for sent mail. */
  date: string;
  has_attachment: boolean;
  folder: ThreadFolder | null;
  labels: string[];
  /** Plain text from the message's body around the match (the start of the body when the match is only in the subject or an address, or when `q` is absent). */
  snippet: string;
};

export type MetricsParams = {
  /** Start of the range: a Date, an ISO 8601 timestamp, or a plain date. */
  from?: string | Date;
  /** End of the range: a Date, an ISO 8601 timestamp, or a plain date. */
  to?: string | Date;
  agent_id?: string;
  interval?: "day" | "hour";
};

export type MetricsCounts = {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  received: number;
  /** Received messages that answered a thread. */
  replies: number;
};

export type Metrics = {
  interval: "day" | "hour";
  from: string;
  to: string;
  agent_id?: string;
  /** A test key counts test mail only; a live key, live mail only. */
  test_mode: boolean;
  /** Every bucket in the range, oldest first, zeros included. */
  data: Array<MetricsCounts & { start: string }>;
  totals: MetricsCounts;
};

export type DnsRecord = {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  /** Exact record value. Copy it verbatim. */
  value: string;
  purpose: "spf" | "dkim" | "dmarc" | "return_path" | "tracking" | "ownership";
  required: boolean;
  verified: boolean;
  /** How to create the record; for SPF and DMARC, when to merge into an existing record. */
  instruction?: string;
  /** The part to add to an existing record when merging (for SPF, e.g. `ip4:…`). */
  merge_token?: string;
};

export type Domain = {
  /** Domain id (`dom_…`). */
  id: string;
  domain: string;
  status: "pending" | "verifying" | "verified" | "failed";
  provider?: string;
  dns_records: DnsRecord[];
  fail_reason?: string | null;
  last_check_at?: string | null;
  verified_at?: string | null;
  created_at: string;
};

/** An allowlist attestation: sends to `address` go through despite a suppression. */
export type SuppressionEntry = {
  id: string;
  address: string;
  attestation: string;
  revoked_at?: string;
  created_at: string;
};

/** One of the workspace's recent recipients that is suppressed (`suppression.list({ view: "suppressed" })`). */
export type SuppressedRecipient = {
  address: string;
  type: "hard_bounce" | "complaint" | "unsubscribe";
  /** `global`, or `workspace:<your id>` for an unsubscribe from your mail. */
  scope: string;
  detail?: string;
  suppressed_at: string;
};

export type Health = {
  status: "healthy" | "degraded";
  timestamp: string;
};

const DEFAULT_BASE = "https://api.mails.ai";
// Bounded exponential backoff for transient failures (429 / retry-safe 5xx).
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;
// The longest a server-requested wait is ever slept, and the default. A rate limit can last an
// hour; sleeping that long inside one call looks like a hang, so a longer wait throws at once.
const MAX_RETRY_WAIT_SECONDS = 60;

class MailsError extends Error {
  type: string;
  code: string;
  status: number;
  requestId?: string;
  param?: string;
  /** Seconds until the call can succeed, when the server said: its `Retry-After`, or a 429 body's
   *  `retry_after_seconds`. */
  retryAfterSeconds?: number;
  /** When that is, as an ISO 8601 UTC time: a 429 body's `resets_at`. On a 429, null when waiting
   *  never helps (a cap that only an upgrade or a deletion lifts). Undefined when the server did
   *  not say. */
  resetsAt?: string | null;
  /** On a 402 (a plan limit, or a feature the plan does not include), the page where the plan can
   *  be changed: the error's `upgrade_url`. The message then ends with it too. */
  upgradeUrl?: string;
  constructor(opts: {
    type: string;
    code: string;
    message: string;
    status: number;
    requestId?: string;
    param?: string;
    retryAfterSeconds?: number;
    resetsAt?: string | null;
    upgradeUrl?: string;
  }) {
    super(opts.message);
    this.name = "MailsError";
    this.type = opts.type;
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.param = opts.param;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.resetsAt !== undefined) this.resetsAt = opts.resetsAt;
    if (opts.upgradeUrl !== undefined) this.upgradeUrl = opts.upgradeUrl;
  }
}

/** A 429: a rate limit or cap refused the call, and the client did not wait it out, because the
 *  reset is more than 60 seconds away (or further than `maxRetryWaitSeconds`), waiting does
 *  not lift it, or the short retries ran out. `resetsAt` and `retryAfterSeconds` say when to
 *  come back, as the API's `resets_at` and `retry_after_seconds` do. */
class RateLimitError extends MailsError {
  constructor(opts: ConstructorParameters<typeof MailsError>[0]) {
    super(opts);
    this.name = "RateLimitError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `Retry-After` in seconds: a number of seconds or an HTTP date. Null when absent or unreadable. */
function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header || !header.trim()) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, (at - now) / 1000);
}

/** What a refused call's error body says about when a limit resets (429s only). */
type LimitReset = { resets_at?: string | null; retry_after_seconds?: number | null };

/**
 * Before retry number `attempt` of a 429 or retry-safe 5xx: how long to sleep, or `stop` and
 * throw now.
 *
 * The API sends `Retry-After` only when the true wait is 60 seconds or less. A longer limit
 * sends no header, and its error body says when it resets (`resets_at`, or null when waiting
 * never helps) and in how many seconds (`retry_after_seconds`). So a wait within `capSeconds`
 * is slept; a longer one, or a reset of null, stops at once; with nothing said, a bounded
 * exponential backoff.
 */
function retryPlan(
  retryAfter: string | null,
  limit: LimitReset | undefined,
  attempt: number,
  capSeconds: number,
  now = Date.now()
): { ms: number } | { stop: true; seconds?: number; resetsAt?: string | null } {
  const header = parseRetryAfter(retryAfter, now);
  if (header !== null && header > 0) {
    if (header <= capSeconds) return { ms: header * 1000 };
    const seconds = Math.ceil(header);
    return { stop: true, seconds, resetsAt: limit?.resets_at ?? new Date(now + seconds * 1000).toISOString() };
  }
  if (limit && limit.resets_at === null) return { stop: true, resetsAt: null };
  if (limit && typeof limit.resets_at === "string") {
    const at = Date.parse(limit.resets_at);
    const seconds =
      typeof limit.retry_after_seconds === "number" ? limit.retry_after_seconds : Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
    if (seconds !== null && seconds > capSeconds) return { stop: true, seconds, resetsAt: limit.resets_at };
    if (seconds !== null && seconds > 0) return { ms: seconds * 1000 };
  }
  return { ms: Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt) };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * A `since` for `events.list`, sent in the form every `created_at` has: the UTC instant with
 * milliseconds (`2026-10-04T09:30:00.000Z`). Takes a Date or an ISO 8601 string; a string with
 * no offset is UTC. A plain date (`2026-10-04`, midnight UTC) is sent as it is. Anything else
 * throws before a request is made; the API would refuse it with the same 400
 * invalid_param_value.
 */
function normalizeSince(value: string | Date): string {
  const fail = () =>
    new MailsError({
      type: "invalid_request_error",
      code: "invalid_param_value",
      message: `since must be a Date or an ISO 8601 timestamp such as 2026-10-04T09:30:00.000Z (or a plain date, 2026-10-04); got ${JSON.stringify(String(value))}.`,
      status: 0,
      param: "since",
    });
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw fail();
    return value.toISOString();
  }
  const s = String(value).trim();
  const day = DATE_ONLY.exec(s);
  if (day) {
    const t = new Date(Date.UTC(+day[1], +day[2] - 1, +day[3]));
    if (t.getUTCFullYear() !== +day[1] || t.getUTCMonth() !== +day[2] - 1 || t.getUTCDate() !== +day[3]) throw fail();
    return s;
  }
  const m = ISO_DATE_TIME.exec(s);
  if (!m) throw fail();
  const [, y, mo, d, h, mi, sec = "0", frac = "", zone = "Z"] = m;
  const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, Number(frac.padEnd(3, "0").slice(0, 3))));
  if (
    local.getUTCFullYear() !== +y || local.getUTCMonth() !== +mo - 1 || local.getUTCDate() !== +d ||
    local.getUTCHours() !== +h || local.getUTCMinutes() !== +mi || local.getUTCSeconds() !== +sec
  ) {
    throw fail();
  }
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = +digits.slice(0, 2);
    const minutes = digits.length > 2 ? +digits.slice(2) : 0;
    if (hours > 23 || minutes > 59) throw fail();
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  return new Date(local.getTime() - offsetMinutes * 60_000).toISOString();
}

/** A time filter (`after`, `before`, `from`, `to`): a Date becomes its ISO 8601 form; a string
 *  goes as it is, for the API to check. */
const timeParam = (v: string | Date) => (v instanceof Date ? v.toISOString() : v);

class MailsClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private maxRetryWaitSeconds: number;

  messages: MessagesResource;
  received: ReceivedResource;
  threads: ThreadsResource;
  drafts: DraftsResource;
  labels: LabelsResource;
  events: EventsResource;
  agents: AgentsResource;
  suppression: SuppressionResource;
  api_keys: ApiKeysResource;
  /** Apps connected by signing in. Needs an API key with `manage` that is not tied to an agent. */
  connected_apps: ConnectedAppsResource;
  webhooks: WebhooksResource;
  domains: DomainsResource;
  metrics: MetricsResource;
  reputation: ReputationResource;
  billing: BillingResource;
  logs: LogsResource;
  /** Test-key helpers: `test.inbound` simulates an inbound email. */
  test: TestResource;

  constructor(opts: ClientOptions = {}) {
    const envKey = typeof process !== "undefined" ? process.env?.MAILS_API_KEY : undefined;
    const envBase = typeof process !== "undefined" ? process.env?.MAILS_BASE_URL : undefined;
    // An empty option or variable counts as unset, as in the Python SDK: MAILS_BASE_URL="" once
    // left the address empty, so every call went to a relative path.
    this.apiKey = opts.apiKey || envKey || "";
    this.baseUrl = (opts.baseUrl || envBase || DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    const cap = opts.maxRetryWaitSeconds;
    this.maxRetryWaitSeconds = typeof cap === "number" && cap >= 0 ? Math.min(cap, MAX_RETRY_WAIT_SECONDS) : MAX_RETRY_WAIT_SECONDS;
    if (!this.apiKey) {
      throw new Error("Mails.ai SDK: apiKey not provided and MAILS_API_KEY env var not set.");
    }

    this.messages = new MessagesResource(this);
    this.received = new ReceivedResource(this);
    this.threads = new ThreadsResource(this);
    this.drafts = new DraftsResource(this);
    this.labels = new LabelsResource(this);
    this.events = new EventsResource(this);
    this.agents = new AgentsResource(this);
    this.suppression = new SuppressionResource(this);
    this.api_keys = new ApiKeysResource(this);
    this.connected_apps = new ConnectedAppsResource(this);
    this.webhooks = new WebhooksResource(this);
    this.domains = new DomainsResource(this);
    this.metrics = new MetricsResource(this);
    this.reputation = new ReputationResource(this);
    this.billing = new BillingResource(this);
    this.logs = new LogsResource(this);
    this.test = new TestResource(this);
  }

  agent(name: string): Agent {
    return new Agent(this, name);
  }

  /** send({ to, subject, body }) — the agent is resolved, or created for you with a key that holds `manage`. */
  async send(input: SendInput): Promise<SendResult>;
  /** send("sarah", { to, subject, body }) — the original form, unchanged. */
  async send(agent: string, input: SendInput): Promise<SendResult>;
  async send(agentOrInput: string | SendInput, maybeInput?: SendInput): Promise<SendResult> {
    return typeof agentOrInput === "string"
      ? this.messages.send(agentOrInput, maybeInput!)
      : this.messages.send(agentOrInput);
  }

  async createAgent(name: string, options?: { domain?: string; allowlist_domains?: string[] }) {
    return this.agents.create(name, options);
  }
  async listAgents(opts?: { limit?: number; cursor?: string; status?: "live" | "all" | "active" | "paused" | "archived" }) {
    return this.agents.list(opts);
  }

  async me(): Promise<MeResult> {
    return this.request("GET", "/api/v1/me");
  }

  /** Search mail by words and filters: received and sent, newest first. */
  async search(params: SearchParams = {}): Promise<ListResult<SearchHit>> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.agent_id) qs.set("agent_id", params.agent_id);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.after) qs.set("after", timeParam(params.after));
    if (params.before) qs.set("before", timeParam(params.before));
    if (params.has_attachment !== undefined) qs.set("has_attachment", String(params.has_attachment));
    if (params.folder) qs.set("folder", params.folder);
    if (params.label) qs.set("label", params.label);
    if (params.type) qs.set("type", params.type);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    return this.request("GET", `/api/v1/search${qs.toString() ? "?" + qs.toString() : ""}`);
  }

  /** Whether the API is up: `healthy` or `degraded`, with the server's time. */
  async health(): Promise<Health> {
    return this.request("GET", "/api/health");
  }

  // Raw helpers used by resources
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headersIn?: Record<string, string>
  ): Promise<T> {
    return this._request<T>(method, path, body, headersIn);
  }

  /** A binary response (an attachment download): the bytes exactly as the API sent them. */
  async requestBytes(method: string, path: string, headersIn?: Record<string, string>): Promise<Uint8Array> {
    const res = await this._send(method, path, undefined, headersIn);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    headersIn?: Record<string, string>
  ): Promise<T> {
    const res = await this._send(method, path, body, headersIn);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // One API call with the retry policy: resolves with the successful response, or throws MailsError.
  private async _send(
    method: string,
    path: string,
    body?: unknown,
    headersIn?: Record<string, string>
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(headersIn ?? {}),
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    // A retry is safe when the request can't have applied a side effect twice:
    // a 429 was REJECTED (rate-limited, never processed), and 5xx is only retried
    // for read methods or when an Idempotency-Key makes a resend a no-op server-side.
    const idempotentMethod = method === "GET" || method === "HEAD";
    const hasIdemKey = Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key");

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload });
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if (res.ok) return res;
      let err: { error?: { type?: string; code?: string; message?: string; param?: string; upgrade_url?: unknown } & LimitReset } = {};
      try {
        err = JSON.parse(await res.text());
      } catch {
        /* not JSON */
      }
      const limited = res.status === 429;
      const limit = limited ? err.error : undefined;
      const retryable = attempt < MAX_RETRIES && (limited || (res.status >= 500 && (idempotentMethod || hasIdemKey)));
      let stop: { seconds?: number; resetsAt?: string | null } | undefined;
      if (retryable) {
        const plan = retryPlan(res.headers.get("retry-after"), limit, attempt, this.maxRetryWaitSeconds);
        if ("ms" in plan) {
          await sleep(plan.ms);
          continue;
        }
        stop = plan;
      }
      const retryAfter = stop ? (stop.seconds ?? null) : (parseRetryAfter(res.headers.get("retry-after")) ?? limit?.retry_after_seconds ?? null);
      const retryAfterSeconds = retryAfter == null ? undefined : Math.ceil(retryAfter);
      const resetsAt =
        stop?.resetsAt !== undefined
          ? stop.resetsAt
          : limit && limit.resets_at !== undefined
            ? limit.resets_at
            : retryAfterSeconds === undefined
              ? undefined
              : new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
      let message = err.error?.message ?? `${method} ${path} failed with ${res.status}`;
      if (stop?.seconds !== undefined) {
        message += ` It resets in ${stop.seconds} s (at ${resetsAt}): longer than this client waits on its own (${this.maxRetryWaitSeconds} s).`;
      }
      // A plan refusal names the page where the plan can be changed; the message ends with it, so
      // it reaches a log or a test report that prints only the message.
      const upgradeUrl = typeof err.error?.upgrade_url === "string" && err.error.upgrade_url ? err.error.upgrade_url : undefined;
      if (upgradeUrl) message += ` Change your plan: ${upgradeUrl}`;
      const fields = {
        type: err.error?.type ?? (limited ? "rate_limit_error" : "api_error"),
        code: err.error?.code ?? "unknown",
        message,
        status: res.status,
        requestId,
        param: err.error?.param,
        retryAfterSeconds,
        resetsAt,
        upgradeUrl,
      };
      throw limited ? new RateLimitError(fields) : new MailsError(fields);
    }
  }

  async requestText(method: string, path: string, body?: unknown, headersIn?: Record<string, string>): Promise<string> {
    const res = await this._send(method, path, body, headersIn);
    return await res.text();
  }

  /**
   * SSE live tail that keeps going until you call `.abort()` on the AbortController it returns
   * (or abort `signal`). The server ends each connection after about 50 seconds and a network
   * can drop one at any time; the stream reconnects by itself from where the server said it
   * was, so no event is missed, and one the server sends again is not handed to `onEvent` a
   * second time (see {@link reconnectingEventStream}).
   *
   * Events arrive in id order, except one whose row was written late: it arrives after newer
   * ones rather than not at all.
   *
   * Without `since` it starts after the newest event there is when you call it (it reads that
   * event's id with `GET /v1/events?limit=1` first): you get what happens from now on, and a
   * connection that drops before the first event misses nothing either. With `since`, it
   * resumes there first.
   *
   * ⚠ `since` here is a resume CURSOR, not a timestamp: a position `onPosition` gave you, or an
   * **event ID** (`evt_…`). That is the opposite of `events.list({ since })`, which takes an
   * ISO timestamp. Passing a timestamp to the stream does not error; it silently replays from
   * the beginning, because every `evt_…` id sorts after a `2026-…` string.
   *
   * `onPosition` is given the stream's position each time it moves: a string to save and pass
   * back as `since` when you start again. A position starts the stream exactly where it was, so
   * an event written late while you were away is not missed; an event id only starts it after
   * that event. It is called after the events before it were handed to `onEvent`. A new process
   * remembers nothing of the last one, so keep the ids you handled if handling one twice would
   * matter: delivery is at least once.
   *
   * `event_types` keeps only those types (exact names; `"*"` or an empty list means all of
   * them). The SDK reads every event and filters here, so the cursor moves past events of
   * other types too: see {@link reconnectingEventStream}.
   *
   * `onError` is called for every failed connection (the stream carries on and retries) and
   * for an error thrown by `onEvent`. A 401 or 403 is the last call: the key is wrong or lacks
   * the `read` scope, so the stream ends instead of retrying. Without `onError`, that last
   * error is written to `console.error`, so the stream never ends without a word.
   */
  stream(opts: {
    since?: string;
    event_types?: string[];
    onEvent: (e: TypedEvent) => void;
    onError?: (err: Error) => void;
    onPosition?: (position: string) => void;
    signal?: AbortSignal;
  }): AbortController {
    const ctrl = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const wanted = (opts.event_types ?? []).map((t) => t.trim()).filter(Boolean);
    const wants = (type: string) => wanted.length === 0 || wanted.includes("*") || wanted.includes(type);
    void reconnectingEventStream({
      fetchImpl: this.fetchImpl,
      // No `event_types` in the request: the filter is `wants`, below.
      url: (since) => `${this.baseUrl}/api/v1/events/stream${since ? "?" + new URLSearchParams({ since }).toString() : ""}`,
      newestUrl: `${this.baseUrl}/api/v1/events?limit=1`,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "text/event-stream" },
      since: opts.since,
      signal: ctrl.signal,
      onEvent: (e) => {
        if (wants(e.type)) opts.onEvent(e);
      },
      onError: opts.onError,
      onPosition: opts.onPosition,
    });
    return ctrl;
  }
}

// Reconnect timing for the event stream. The wait before a reconnect starts at 1 s, doubles
// after every failure up to 30 s, and drops back to 1 s as soon as a connection opens.
const STREAM_RETRY_START_MS = 1_000;
const STREAM_RETRY_CAP_MS = 30_000;
// The server sends a keepalive comment every 2 s, so this long with no bytes at all means the
// connection is dead (a network that dropped without closing it) and is replaced.
const STREAM_STALL_MS = 30_000;
// How many delivered event ids a stream remembers, so one the server sends again is dropped.
const STREAM_REMEMBERED_IDS = 5_000;

/** Remembers the last `max` ids it was given. Returns false for one it still remembers. */
function rememberIds(max: number): (id: string) => boolean {
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > max) seen.delete(seen.values().next().value as string); // the oldest
    return true;
  };
}

/**
 * The event stream, kept open: one connection after another, each resuming from where the
 * last one was, until `signal` aborts.
 *
 * Until 2026-10-05 `stream` (and so `agent.onReply` / `onMessage`) made ONE connection: when
 * the server closed it at 50 s, the listener stopped for good, with no error, and an agent
 * "listening for replies" went deaf in under a minute.
 *
 * - Without `since`, the cursor starts at the newest event the key can see, read with
 *   `GET /v1/events?limit=1` before the first connection ("0", before every id, when there is
 *   none yet). The server starts a connection without a cursor at its own newest event, so
 *   until 2026-10-05 a connection that closed before any event reconnected at "now" and
 *   skipped what landed in between: the very reply `agent.onReply` waits for. The CLI's
 *   `followEvents` reads the cursor the same way.
 * - The server says where the stream is in an SSE `id:` with no data, its POSITION
 *   (`evt_…~<n>`): when a connection opens, after every batch of events, and when a newer
 *   one spares the client a repeat. That is the cursor a reconnect resumes from, and it
 *   carries what a bare event id cannot: an event whose row is written late, with an id
 *   smaller than one already sent, is still sent after a reconnect. Once a connection has
 *   given a position, an event's own id never replaces it. (A server that sends no positions
 *   is resumed from the id of the last event, as before 2026-10-06.)
 * - Delivery is at least once: resuming from a position can bring an event a second time. The
 *   last 5,000 ids handed to `onEvent` are remembered and such an event is dropped, so
 *   `onEvent` hears each event once.
 * - Every event is read, whatever types the caller asked for: `stream` filters after the
 *   cursor has moved. Until 2026-10-06 the filter went to the server as `event_types`. The
 *   server then sends nothing for an event of another type, so the cursor stayed at the last
 *   matching event, and every reconnect read the same events again. One connection reads about
 *   1,250 (50 every 2 s for 50 s), so a listener for one type with more than that many other
 *   events after its cursor never reached a new one: `agent.onReply` in a workspace that sends
 *   a few hundred emails between two replies went deaf, with no error.
 * - Every failed connection goes to `onError`, then the stream waits and tries again: 1 s,
 *   doubling to 30 s, back to 1 s once a connection opens. A connection the server simply
 *   finished is not a failure.
 * - A 401 or 403 ends it after one `onError` (or one `console.error` when there is no
 *   `onError`): the key is wrong or lacks the `read` scope.
 */
async function reconnectingEventStream(o: {
  fetchImpl: typeof fetch;
  url: (since: string | undefined) => string;
  /** `GET /v1/events?limit=1`: the newest event, whose id is the cursor when there is no `since`. */
  newestUrl: string;
  headers: Record<string, string>;
  since?: string;
  signal: AbortSignal;
  onEvent: (e: TypedEvent) => void;
  onError?: (err: Error) => void;
  onPosition?: (position: string) => void;
}): Promise<void> {
  const report = (err: unknown) => {
    try {
      o.onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* the caller's own onError threw; nothing more to tell it */
    }
  };
  // The key is wrong or lacks the `read` scope: retrying cannot help, so this is the stream's
  // last word. With no onError it goes to console.error, never nowhere.
  const refused = async (res: Response) => {
    let message = `event stream refused with HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* no JSON body */
    }
    const err = new MailsError({
      type: res.status === 401 ? "authentication_error" : "permission_error",
      code: res.status === 401 ? "invalid_api_key" : "insufficient_scope",
      message,
      status: res.status,
      requestId: res.headers.get("x-request-id") ?? undefined,
    });
    if (o.onError) report(err);
    else console.error(`mails.ai event stream stopped: ${err.message}`);
  };
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (o.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        o.signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      o.signal.addEventListener("abort", done, { once: true });
    });

  let cursor = o.since || undefined;
  let given: string | undefined; // the last position handed to onPosition
  const firstTime = rememberIds(STREAM_REMEMBERED_IDS);
  let delay = STREAM_RETRY_START_MS;
  while (!o.signal.aborted) {
    const conn = new AbortController();
    const stopConn = () => conn.abort();
    o.signal.addEventListener("abort", stopConn, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => conn.abort(new Error(`event stream stalled: no data for ${STREAM_STALL_MS / 1000} s`)), STREAM_STALL_MS);
    };
    let failed = false;
    try {
      alive();
      if (cursor === undefined) {
        const newest = await o.fetchImpl(o.newestUrl, { headers: { ...o.headers, Accept: "application/json" }, signal: conn.signal });
        if (newest.status === 401 || newest.status === 403) {
          await refused(newest);
          return;
        }
        if (!newest.ok) throw new Error(`reading the newest event answered HTTP ${newest.status}`);
        const page = (await newest.json()) as { data?: Array<{ id?: unknown }> };
        const id = page.data?.[0]?.id;
        cursor = typeof id === "string" && id ? id : "0";
      }
      const res = await o.fetchImpl(o.url(cursor), { headers: o.headers, signal: conn.signal });
      if (res.status === 401 || res.status === 403) {
        await refused(res);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`event stream answered HTTP ${res.status}`);
      delay = STREAM_RETRY_START_MS; // connected: the next wait starts from 1 s again

      // Server-sent events (WHATWG "event stream" rules): fields up to a blank line make one
      // event; lines starting with ":" are comments (the keepalives).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let id: string | undefined;
      let idInBlock = false;
      let positioned = false; // this connection has said where the stream is
      let data: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const m = /\r\n|\n|\r/.exec(buf);
          if (!m) break;
          if (m[0] === "\r" && m.index === buf.length - 1) break; // maybe the first half of \r\n
          const line = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          if (line === "") {
            if (data.length) {
              let evt: TypedEvent | null = null;
              try {
                evt = JSON.parse(data.join("\n")) as TypedEvent;
              } catch {
                /* not an event body; skip it */
              }
              if (evt) {
                if (!positioned && (id ?? evt.id)) cursor = id ?? evt.id;
                if (typeof evt.id !== "string" || firstTime(evt.id)) {
                  try {
                    o.onEvent(evt);
                  } catch (err) {
                    report(err);
                  }
                }
              }
            } else if (idInBlock && id) {
              // An id with no data: the stream's position.
              positioned = true;
              cursor = id;
              if (id !== given) {
                given = id;
                try {
                  o.onPosition?.(id);
                } catch (err) {
                  report(err);
                }
              }
            }
            data = [];
            idInBlock = false;
            continue;
          }
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let val = colon < 0 ? "" : line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "data") data.push(val);
          else if (field === "id" && !val.includes("\u0000")) {
            id = val;
            idInBlock = true;
          }
        }
      }
    } catch (err) {
      if (o.signal.aborted) return;
      failed = true;
      report(conn.signal.aborted && conn.signal.reason instanceof Error ? conn.signal.reason : err);
    } finally {
      if (stall) clearTimeout(stall);
      o.signal.removeEventListener("abort", stopConn);
    }
    if (o.signal.aborted) return;
    await wait(delay);
    if (failed) delay = Math.min(delay * 2, STREAM_RETRY_CAP_MS);
  }
}

class MessagesResource {
  constructor(private c: MailsClient) {}
  /** send({ to, subject, body }) — the agent is resolved, or created for you with a key that holds `manage`. */
  send(input: SendInput): Promise<SendResult>;
  /** send("sarah", { to, subject, body }) — the original form, unchanged. */
  send(agent: string, input: SendInput): Promise<SendResult>;
  send(agentOrInput: string | SendInput, maybeInput?: SendInput): Promise<SendResult> {
    const input: SendInput = typeof agentOrInput === "string" ? maybeInput! : agentOrInput;
    const agent = typeof agentOrInput === "string" ? agentOrInput : input.agent;
    const body = {
      agent,
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body_text: input.body_text ?? input.body,
      body_html: input.body_html,
      reply_to: input.reply_to,
      in_reply_to_message_id: input.in_reply_to_message_id,
      references: input.references,
      attachments: input.attachments,
      metadata: input.metadata,
      pool_hint: input.pool_hint,
      scheduled_at: input.scheduled_at,
      tags: input.tags,
      list_unsubscribe: input.list_unsubscribe,
    };
    const headers: Record<string, string> = {};
    if (input.idempotency_key) headers["Idempotency-Key"] = input.idempotency_key;
    return this.c.request("POST", "/api/v1/messages", body, headers);
  }
  /** Up to 100 sends in one call, each shaped like `send`'s input (`agent` optional, `from` and
   *  `references` honoured, as on `send`) but with no `attachments`: the API refuses a batch that
   *  carries files (422), so send those on their own. Each one succeeds or fails on its own. */
  batch(messages: Array<Omit<SendInput, "idempotency_key" | "attachments">>, opts?: { idempotency_key?: string }) {
    const headers: Record<string, string> = {};
    if (opts?.idempotency_key) headers["Idempotency-Key"] = opts.idempotency_key;
    return this.c.request<{ data: Array<SendResult | { error: { type: string; code: string; message: string } }>; batch_size: number }>(
      "POST",
      "/api/v1/messages/batch",
      // `body` is this SDK's shorthand for `body_text`, the field the API reads, as on send. Until
      // 2026-10-05 batch sent it through unchanged, so `{ …, body }` came back 400.
      messages.map(({ body, ...m }) => ({ ...m, body_text: m.body_text ?? body })),
      headers
    );
  }
  reply(id: string, input: ReplyInput) {
    const { idempotency_key, ...rest } = input;
    const headers: Record<string, string> = {};
    if (idempotency_key) headers["Idempotency-Key"] = idempotency_key;
    return this.c.request<SendResult & { in_reply_to_message_id: string }>(
      "POST",
      `/api/v1/messages/${encodeURIComponent(id)}/reply`,
      { ...rest, body_text: rest.body_text ?? rest.body },
      headers
    );
  }
  forward(id: string, input: ForwardInput) {
    const { idempotency_key, ...rest } = input;
    const headers: Record<string, string> = {};
    if (idempotency_key) headers["Idempotency-Key"] = idempotency_key;
    return this.c.request<SendResult & { forwarded_from: string }>(
      "POST",
      `/api/v1/messages/${encodeURIComponent(id)}/forward`,
      rest,
      headers
    );
  }
  /** Ask for a second, independent review of content refused with `cold_email_prohibited`.
   *  Send the SAME subject and body the refused send used: `overturned` clears exactly that
   *  content for 24 hours, `upheld` means the refusal stands. */
  appeal(input: AppealInput) {
    return this.c.request<AppealResult>("POST", "/api/v1/messages/appeal", {
      agent: input.agent,
      subject: input.subject,
      body_text: input.body_text ?? input.body,
      body_html: input.body_html,
    });
  }
  cancel(id: string) {
    return this.c.request<{ id: string; status: "canceled"; canceled_at: string }>(
      "POST",
      `/api/v1/messages/${encodeURIComponent(id)}/cancel`
    );
  }
  reschedule(id: string, scheduled_at: string) {
    return this.c.request<{ id: string; scheduled_at: string; status: "scheduled" }>(
      "PATCH",
      `/api/v1/messages/${encodeURIComponent(id)}`,
      { scheduled_at }
    );
  }
  raw(id: string) {
    return this.c.requestText("GET", `/api/v1/messages/${encodeURIComponent(id)}/raw`);
  }
  /** `q` is a substring of the subject, body or recipients; word search is `client.search`. */
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; thread_id?: string; q?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.thread_id) qs.set("thread_id", opts.thread_id);
    if (opts?.q) qs.set("q", opts.q);
    return this.c.request<ListResult<SendResult>>(
      "GET",
      `/api/v1/messages${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<SendResult>("GET", `/api/v1/messages/${encodeURIComponent(id)}`);
  }
}

/**
 * A plus address of an agent: its `receiving_address` with `+<tag>` before the `@`, which reaches
 * the same agent. Give each test run or sign-up its own, then wait for mail sent to it alone:
 *
 *   const email = plusAddress(agent.receiving_address, `run-${Date.now()}`);
 *   // …sign up with `email`…
 *   const { message } = await client.received.wait({ to: email, has: "code" });
 *
 * The tag is lowercased, as mail addresses are matched in lower case; it may hold letters, digits,
 * `.`, `_`, `-` and `+`. The part of an address before the `@` holds at most 64 characters, so a
 * long receiving address leaves less room for the tag, and one that is 64 characters already has
 * none: the function throws, saying how much room there is.
 */
export function plusAddress(receivingAddress: string, tag: string): string {
  const at = receivingAddress.lastIndexOf("@");
  if (at < 1) throw new Error(`Not an address: ${JSON.stringify(receivingAddress)}`);
  const t = tag.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  if (!/^[a-z0-9._+-]{1,40}$/.test(t)) throw new Error(`A tag is 1 to 40 letters, digits, ".", "_", "-" or "+". Received: ${JSON.stringify(tag)}`);
  const local = receivingAddress.slice(0, at).split("+")[0];
  const room = 64 - local.length - 1;
  if (t.length > room) {
    throw new Error(
      room < 1
        ? `${receivingAddress} has no room for a tag: the part of an address before the @ holds at most 64 characters, and it already has ${local.length}.`
        : `The part of an address before the @ holds at most 64 characters, so a tag on ${receivingAddress} can have at most ${room}. Received ${t.length}: ${JSON.stringify(tag)}`
    );
  }
  return `${local}+${t}@${receivingAddress.slice(at + 1)}`.toLowerCase();
}

class ReceivedResource {
  attachments: ReceivedAttachmentsResource;
  constructor(private c: MailsClient) {
    this.attachments = new ReceivedAttachmentsResource(c);
  }
  /** `q` is a substring of the subject, body or sender address; word search is `client.search`.
   *  `from` is exact: an address, or a domain and its subdomains. `to` is the address the mail was
   *  sent to, a plus address included ({@link plusAddress}). `since` is an ISO 8601 time. */
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; thread_id?: string; q?: string; from?: string; to?: string; since?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.thread_id) qs.set("thread_id", opts.thread_id);
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.from) qs.set("from", opts.from);
    if (opts?.to) qs.set("to", opts.to);
    if (opts?.since) qs.set("since", opts.since);
    return this.c.request<ListResult<ReceivedMessage>>(
      "GET",
      `/api/v1/messages/received${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  /** The newest received message that matches, waiting up to `timeout` seconds (0 to 50, default
   *  30) for one to arrive; `message` is null when none did. `since` defaults to the last 5
   *  minutes; `has` is `code` or `link`; `to` takes only mail sent to that address, such as the plus
   *  address one test run signed up with ({@link plusAddress}). Mail judged forged and quarantined
   *  mail never match. Throws a 402 `plan_limit_exceeded` at once when the newest mail sent to `to`
   *  came past the plan's plus addresses a day, as only a record of it was kept.
   *  A sign-up code: `(await client.received.wait({ from: "github.com", has: "code" })).message?.codes?.[0]?.value`. */
  wait(opts?: { agent_id?: string; from?: string; to?: string; since?: string; has?: "code" | "link"; timeout?: number }) {
    const qs = new URLSearchParams();
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.from) qs.set("from", opts.from);
    if (opts?.to) qs.set("to", opts.to);
    if (opts?.since) qs.set("since", opts.since);
    if (opts?.has) qs.set("has", opts.has);
    if (opts?.timeout !== undefined) qs.set("timeout", String(opts.timeout));
    return this.c.request<{ message: ReceivedMessage | null; timed_out: boolean }>(
      "GET",
      `/api/v1/messages/received/wait${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<ReceivedMessage & { raw_url: string }>(
      "GET",
      `/api/v1/messages/received/${encodeURIComponent(id)}`
    );
  }
}

class ReceivedAttachmentsResource {
  constructor(private c: MailsClient) {}
  /** The files on a received message, and any that were not kept (`omitted`), with the reason:
   *  `omitted_count` counts them all (past the 100 listed), and `raw_omitted` says why when the
   *  raw email itself was not kept. */
  list(messageId: string) {
    return this.c.request<{
      data: ReceivedAttachment[];
      omitted?: OmittedAttachment[];
      omitted_count?: number;
      raw_omitted?: "too_large" | "budget" | "over_quota" | "unavailable";
    }>(
      "GET",
      `/api/v1/messages/received/${encodeURIComponent(messageId)}/attachments`
    );
  }
  /** One file's bytes, exactly as received. `inline: true` only changes how a browser shows it
   *  (a raster image displayed instead of saved); the bytes are the same. */
  download(messageId: string, attachmentId: string, opts?: { inline?: boolean }): Promise<Uint8Array> {
    return this.c.requestBytes(
      "GET",
      `/api/v1/messages/received/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${opts?.inline ? "?inline=1" : ""}`
    );
  }
}

class ThreadsResource {
  constructor(private c: MailsClient) {}
  /** Without `folder`, every folder except trash. `q` is a substring of the subject or participants.
   *  Without `mode`, the threads of the key's own mode: a live key lists threads that hold live
   *  mail, a test key threads of test mail only; `mode: "all"` lists both. */
  list(opts?: {
    limit?: number;
    cursor?: string;
    agent_id?: string;
    status?: "open" | "closed" | "archived";
    folder?: ThreadFolder | "all";
    read?: boolean;
    label?: string;
    mode?: "live" | "test" | "all";
    q?: string;
  }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.folder) qs.set("folder", opts.folder);
    if (opts?.read !== undefined) qs.set("read", String(opts.read));
    if (opts?.label) qs.set("label", opts.label);
    if (opts?.mode) qs.set("mode", opts.mode);
    if (opts?.q) qs.set("q", opts.q);
    return this.c.request<ListResult<ThreadRow>>("GET", `/api/v1/threads${qs.toString() ? "?" + qs.toString() : ""}`);
  }
  get(id: string) {
    return this.c.request<ThreadDetail>("GET", `/api/v1/threads/${encodeURIComponent(id)}`);
  }
  /** `folder` moves the thread (to `trash` to delete it; back to `inbox` to restore it);
   *  `labels` / `label_ids` replace its labels; `read` marks it read or unread. */
  update(
    id: string,
    patch: {
      labels?: string[];
      label_ids?: string[];
      status?: "open" | "closed" | "archived";
      read?: boolean;
      folder?: Exclude<ThreadFolder, "sent">;
    }
  ) {
    return this.c.request<ThreadRow>("PATCH", `/api/v1/threads/${encodeURIComponent(id)}`, patch);
  }
  /** Moves the thread to trash (`deleted: false`, the thread comes back), or with
   *  `permanent: true` deletes it and its messages for good (`{ id, deleted: true }`). */
  remove(id: string, opts?: { permanent?: boolean }) {
    return this.c.request<(ThreadRow & { deleted: false }) | { id: string; deleted: true }>(
      "DELETE",
      `/api/v1/threads/${encodeURIComponent(id)}${opts?.permanent ? "?permanent=true" : ""}`
    );
  }
}

class LabelsResource {
  constructor(private c: MailsClient) {}
  list() {
    return this.c.request<ListResult<Label>>("GET", "/api/v1/labels");
  }
  /** `name` is unique in the workspace, ignoring case; `color` defaults to `gray`. */
  create(input: { name: string; color?: LabelColor }) {
    return this.c.request<Label>("POST", "/api/v1/labels", input);
  }
  get(id: string) {
    return this.c.request<Label>("GET", `/api/v1/labels/${encodeURIComponent(id)}`);
  }
  /** Renaming a label renames it on every thread that carries it. */
  update(id: string, patch: { name?: string; color?: LabelColor }) {
    return this.c.request<Label>("PATCH", `/api/v1/labels/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string) {
    return this.c.request<{ id: string; deleted: boolean }>("DELETE", `/api/v1/labels/${encodeURIComponent(id)}`);
  }
}

class DraftsResource {
  constructor(private c: MailsClient) {}
  create(input: {
    /** The agent to send as. Optional, as on {@link SendInput.agent}. */
    agent?: string;
    to: string | string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body_text?: string;
    body_html?: string;
    reply_to?: string;
    in_reply_to_message_id?: string;
    send_at?: string;
    tags?: Tag[];
    /** One-click unsubscribe, as on {@link SendInput.list_unsubscribe}. Off by default. */
    list_unsubscribe?: boolean;
  }) {
    return this.c.request<DraftRow>("POST", "/api/v1/drafts", input);
  }
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; status?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.status) qs.set("status", opts.status);
    return this.c.request<ListResult<DraftRow>>("GET", `/api/v1/drafts${qs.toString() ? "?" + qs.toString() : ""}`);
  }
  get(id: string) {
    return this.c.request<DraftRow>("GET", `/api/v1/drafts/${encodeURIComponent(id)}`);
  }
  update(id: string, patch: Record<string, unknown>) {
    return this.c.request<DraftRow>("PATCH", `/api/v1/drafts/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string) {
    return this.c.request<{ id: string; deleted_at: string }>(
      "DELETE",
      `/api/v1/drafts/${encodeURIComponent(id)}`
    );
  }
  /** `idempotency_key` is sent as the `Idempotency-Key` header, as on a send: a retry with the
   *  same key replays the first answer instead of sending the draft twice. */
  send(id: string, opts?: { send_at?: string; idempotency_key?: string }) {
    const { idempotency_key, ...body } = opts ?? {};
    return this.c.request<{ id: string; status: string; message_id?: string; thread_id?: string; sent_at?: string; send_at?: string; refused_recipients?: string[] }>(
      "POST",
      `/api/v1/drafts/${encodeURIComponent(id)}/send`,
      body,
      idempotency_key ? { "Idempotency-Key": idempotency_key } : undefined
    );
  }
}

class EventsResource {
  constructor(private c: MailsClient) {}
  /** `since` (a Date or an ISO 8601 string) keeps events created at or after it; it is sent
   *  in the form every `created_at` has, and a value that is not a time throws before any
   *  request, as the API would refuse it. */
  list(opts?: { limit?: number; cursor?: string; event_type?: string; agent_id?: string; since?: string | Date }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.event_type) qs.set("event_type", opts.event_type);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.since) qs.set("since", normalizeSince(opts.since));
    return this.c.request<ListResult<TypedEvent>>(
      "GET",
      `/api/v1/events${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<TypedEvent>("GET", `/api/v1/events/${encodeURIComponent(id)}`);
  }
  redeliver(id: string) {
    return this.c.request<{ event_id: string; webhook_endpoint_ids: string[]; scheduled_at: string }>(
      "POST",
      `/api/v1/events/${encodeURIComponent(id)}/redeliver`,
      {}
    );
  }
  // Convenience — wraps client.stream
  stream(opts: { since?: string; event_types?: string[]; onEvent: (e: TypedEvent) => void; onError?: (err: Error) => void; onPosition?: (position: string) => void }) {
    return this.c.stream(opts);
  }
}

class AgentsResource {
  constructor(private c: MailsClient) {}
  /** Creates an agent on the workspace's mails.ai address, named `name`. */
  create(name: string, opts?: AgentCreateOptions): Promise<AgentRow>;
  /**
   * Creates an agent at an address on a domain the workspace has verified (support@acme.com),
   * named after the part before the @. With `forwarding: true`, the mail service that already
   * hosts the address forwards its mail to the agent's `forwarding_address`, so no MX record
   * changes; `verifyForwarding` tests that forward.
   */
  create(opts: AgentCreateOptions & { address: string; forwarding?: boolean }): Promise<AgentRow>;
  create(nameOrOpts: string | (AgentCreateOptions & { address: string; forwarding?: boolean }), opts?: AgentCreateOptions) {
    const body = typeof nameOrOpts === "string" ? { name: nameOrOpts, ...opts } : { ...nameOrOpts };
    return this.c.request<AgentRow>("POST", "/api/v1/agents", body);
  }
  /** The agent's inbox at a glance: unread and thread counts per folder and per label. */
  inbox(id: string) {
    return this.c.request<InboxSummary>("GET", `/api/v1/agents/${encodeURIComponent(id)}/inbox`);
  }
  /** Lists agents. `status` defaults to `live` (everything except archived) — an archived
   *  agent cannot send, so it is a tombstone rather than a candidate. Pass `"all"` to
   *  include them, or an exact status to filter. */
  list(opts?: { limit?: number; cursor?: string; status?: "live" | "all" | "active" | "paused" | "archived" }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.status) qs.set("status", opts.status);
    return this.c.request<ListResult<AgentRow>>(
      "GET",
      `/api/v1/agents${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<AgentRow>("GET", `/api/v1/agents/${encodeURIComponent(id)}`);
  }
  update(
    id: string,
    patch: {
      status?: "active" | "paused";
      daily_send_limit?: number | null;
      hourly_send_limit?: number | null;
      allowlist_domains?: string[];
      blocklist_domains?: string[];
      classify_inbound?: boolean;
      /** Forwarding mode on or off, for an agent at an address on the workspace's own domain.
       *  Turning it on or off starts the forwarding test again. */
      forwarding?: boolean;
    }
  ) {
    return this.c.request<AgentRow>("PATCH", `/api/v1/agents/${encodeURIComponent(id)}`, patch);
  }
  /**
   * Sends one test email, from mails.ai, to the address of an agent in forwarding mode, and
   * answers the agent at once. `forwarding_status` turns `verified` when the test comes back
   * through the forward, or `failing` if it is still missing 15 minutes later; read it with
   * `agents.get`. While a test is on its way, another call sends nothing. Needs a live key.
   */
  verifyForwarding(id: string) {
    return this.c.request<AgentRow>("POST", `/api/v1/agents/${encodeURIComponent(id)}/forwarding/verify`);
  }
  archive(id: string) {
    return this.c.request<{ id: string; status: string; archived_at: string }>(
      "DELETE",
      `/api/v1/agents/${encodeURIComponent(id)}`
    );
  }
}

class SuppressionResource {
  constructor(private c: MailsClient) {}
  check(address: string) {
    return this.c.request<SuppressionLookup>("GET", `/api/v1/suppression?address=${encodeURIComponent(address)}`);
  }
  /** The allowlist attestations, or with `view: "suppressed"` the workspace's recent
   *  recipients that are suppressed (bounced, complained or unsubscribed). */
  list(opts?: { limit?: number; cursor?: string; view?: undefined }): Promise<ListResult<SuppressionEntry>>;
  list(opts: { limit?: number; cursor?: string; view: "suppressed" }): Promise<ListResult<SuppressedRecipient>>;
  list(opts?: { limit?: number; cursor?: string; view?: "suppressed" }): Promise<ListResult<SuppressionEntry> | ListResult<SuppressedRecipient>>;
  list(opts?: { limit?: number; cursor?: string; view?: "suppressed" }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.view) qs.set("view", opts.view);
    return this.c.request<ListResult<SuppressionEntry> | ListResult<SuppressedRecipient>>(
      "GET",
      `/api/v1/suppression${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  allow(address: string, attestation: string) {
    return this.c.request<{ id: string; address: string; attestation: string; created_at: string }>(
      "POST",
      "/api/v1/suppression/allow",
      { address, attestation }
    );
  }
  revoke(id: string) {
    return this.c.request<{ id: string; revoked_at: string }>(
      "DELETE",
      `/api/v1/suppression/allow/${encodeURIComponent(id)}`
    );
  }
}

class ApiKeysResource {
  constructor(private c: MailsClient) {}
  create(input: {
    name?: string;
    agent_id?: string;
    /** `send` sends mail, `read` reads it, `manage` changes agents, webhooks, domains and keys,
     *  and `draft` writes drafts but can neither send nor schedule one. Default `send` + `read`. */
    scopes?: ("send" | "read" | "manage" | "draft")[];
    mode?: "live" | "test";
    expires_at?: string;
  }) {
    return this.c.request<ApiKeyRow & { key: string }>("POST", "/api/v1/api-keys", input);
  }
  list(opts?: { limit?: number; cursor?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    return this.c.request<ListResult<ApiKeyRow>>(
      "GET",
      `/api/v1/api-keys${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  revoke(id: string) {
    return this.c.request<{ id: string; revoked_at: string }>(
      "DELETE",
      `/api/v1/api-keys/${encodeURIComponent(id)}`
    );
  }
}

class ConnectedAppsResource {
  constructor(private c: MailsClient) {}
  /** The apps connected to the workspace by signing in that can still act, newest first. A
   *  connected app may not call this (403 `connected_app_not_allowed`). */
  list(opts?: { limit?: number; cursor?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    return this.c.request<ListResult<ConnectedApp>>(
      "GET",
      `/api/v1/oauth/grants${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  /** Ends the app's sign-in at once: its tokens stop working. The API keys and webhook endpoints
   *  it created stay, and the answer counts them. Revoking it again returns the same `revoked_at`. */
  revoke(id: string) {
    return this.c.request<ConnectedApp & { revoked_at: string }>(
      "DELETE",
      `/api/v1/oauth/grants/${encodeURIComponent(id)}`
    );
  }
}

class WebhooksResource {
  constructor(private c: MailsClient) {}
  create(input: { url: string; event_types?: string[]; description?: string }) {
    return this.c.request<WebhookRow & { signing_secret: string }>("POST", "/api/v1/webhooks", input);
  }
  list(opts?: { limit?: number; cursor?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    return this.c.request<ListResult<WebhookRow>>(
      "GET",
      `/api/v1/webhooks${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<WebhookRow>("GET", `/api/v1/webhooks/${encodeURIComponent(id)}`);
  }
  update(id: string, patch: { url?: string; event_types?: string[]; description?: string; active?: boolean }) {
    return this.c.request<WebhookRow>("PATCH", `/api/v1/webhooks/${encodeURIComponent(id)}`, patch);
  }
  /** A new signing secret, shown once. For 24 hours every delivery is also signed with the
   *  previous one, so the receiver can switch over without dropping events. */
  rotateSecret(id: string) {
    return this.c.request<WebhookSecretRotated>("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`);
  }
  /** Send a signed test event to the endpoint to verify reachability + signature handling. */
  test(id: string) {
    return this.c.request<{
      ok: boolean;
      http_status?: number;
      error?: string;
      webhook_endpoint_id?: string;
      event_id?: string;
      delivery_id?: string;
      response_excerpt?: string;
    }>(
      "POST",
      `/api/v1/webhooks/${encodeURIComponent(id)}/test`
    );
  }
  remove(id: string) {
    return this.c.request<{ id: string; deleted_at: string }>(
      "DELETE",
      `/api/v1/webhooks/${encodeURIComponent(id)}`
    );
  }
  deliveries(webhookId: string, opts?: { limit?: number; cursor?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    return this.c.request<ListResult<WebhookDelivery>>(
      "GET",
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  replayDelivery(deliveryId: string) {
    return this.c.request<{ delivery_id: string; event_id: string; scheduled: string[]; scheduled_at: string }>(
      "POST",
      `/api/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
      {}
    );
  }
  verify(body: string, signature: string, secret: string, toleranceSec = 300): TypedEvent | null {
    return verifyWebhook(body, signature, secret, toleranceSec);
  }
}

class DomainsResource {
  constructor(private c: MailsClient) {}
  list() {
    return this.c.request<ListResult<Domain>>("GET", "/api/v1/domains");
  }
  /** Register a custom sending domain. The answer lists the DNS records to create. */
  create(domain: string) {
    return this.c.request<Domain>("POST", "/api/v1/domains", { domain });
  }
  get(id: string) {
    return this.c.request<Domain>("GET", `/api/v1/domains/${encodeURIComponent(id)}`);
  }
  remove(id: string) {
    return this.c.request<{ id: string; deleted: boolean }>("DELETE", `/api/v1/domains/${encodeURIComponent(id)}`);
  }
  /** Check the domain's DNS records now; the answer carries each record's `verified`. */
  verify(id: string) {
    return this.c.request<Domain>("POST", `/api/v1/domains/${encodeURIComponent(id)}/verify`);
  }
}

class MetricsResource {
  constructor(private c: MailsClient) {}
  /** Sent, delivered, bounced, complained, received and reply counts per day or hour. */
  get(params: MetricsParams = {}) {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", timeParam(params.from));
    if (params.to) qs.set("to", timeParam(params.to));
    if (params.agent_id) qs.set("agent_id", params.agent_id);
    if (params.interval) qs.set("interval", params.interval);
    return this.c.request<Metrics>("GET", `/api/v1/metrics${qs.toString() ? "?" + qs.toString() : ""}`);
  }
}

class TestResource {
  constructor(private c: MailsClient) {}
  /** Simulate an inbound email to one of your agents. TEST key only: it runs the real
   *  classifier and emits the real event and webhooks, without any mail being sent. */
  inbound(input: TestInboundInput) {
    return this.c.request<TestInboundResult>("POST", "/api/v1/test/inbound", input);
  }
}

class ReputationResource {
  constructor(private c: MailsClient) {}
  get(agentId?: string) {
    const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    return this.c.request<Reputation>("GET", `/api/v1/reputation${qs}`);
  }
}

class BillingResource {
  constructor(private c: MailsClient) {}
  /** A Stripe billing-portal link. `price_lookup_key` is used only when the workspace has no
   *  Stripe customer yet (its first checkout). */
  portal(returnUrl?: string, opts?: { price_lookup_key?: string }) {
    return this.c.request<{ url: string; mock: boolean }>(
      "POST",
      "/api/v1/billing/portal",
      { return_url: returnUrl, price_lookup_key: opts?.price_lookup_key }
    );
  }
  usage() {
    return this.c.request<UsageResult>("GET", "/api/v1/billing/usage");
  }
}

class LogsResource {
  constructor(private c: MailsClient) {}
  list(opts?: { limit?: number; cursor?: string; category?: string; action?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.category) qs.set("category", opts.category);
    if (opts?.action) qs.set("action", opts.action);
    return this.c.request<ListResult<LogEntry>>("GET", `/api/v1/logs${qs.toString() ? "?" + qs.toString() : ""}`);
  }
}

class Agent {
  private _id?: string;
  constructor(private client: MailsClient, private name: string) {}
  async send(input: SendInput): Promise<SendResult> {
    return this.client.send(this.name, input);
  }
  /** `since` takes a Date or an ISO 8601 string, as on `events.list`. */
  async listReplies(opts?: { limit?: number; since?: string | Date }): Promise<ListResult<InboundEvent>> {
    // The API filters on the exact type, so every event in the page is an inbound one.
    return this.client.events.list({ event_type: "reply.received", agent_id: this.name, ...opts }) as Promise<ListResult<InboundEvent>>;
  }
  /**
   * List cold/first-contact inbound (`message.received`) for this agent — messages
   * from senders that are NOT replies to one of your sends (new leads, support
   * requests, strangers). Mail from a forged sender surfaces separately as
   * `message.received.unauthenticated`. Mirrors {@link listReplies}.
   */
  async listMessages(opts?: { limit?: number; since?: string | Date }): Promise<ListResult<InboundEvent>> {
    return this.client.events.list({ event_type: "message.received", agent_id: this.name, ...opts }) as Promise<ListResult<InboundEvent>>;
  }
  async reputation() {
    return this.client.reputation.get(this.name);
  }

  /**
   * Subscribe to reply.received events for this agent. Opens an SSE stream,
   * keeps the reply.received events and dispatches to `callback` those of this
   * agent. Resolves the agent name → id once on the first such event so later
   * ones skip the lookup. The stream reconnects by itself and keeps listening
   * until aborted (see {@link MailsClient.stream}).
   *
   * @returns AbortController — call `.abort()` to stop listening. Caller can
   *   also pass `opts.signal` to chain into an existing abort flow.
   *
   * A reply is scanned for prompt injection but not read for intent: its `intent` is always
   * `general_reply` and its `entities` empty (intent is for {@link onMessage}).
   *
   * @example
   *   const ctrl = agent.onReply((event) => {
   *     // Quarantined, not scanned (no score) or 0.5 and up: a person decides.
   *     if (event.quarantined || typeof event.injection_score !== "number" || event.injection_score >= 0.5) {
   *       return hold(event);
   *     }
   *     console.log(event.thread_id, event.injection_score);
   *   });
   *   // …later
   *   ctrl.abort();
   */
  onReply(
    callback: (event: InboundEvent) => void | Promise<void>,
    opts?: {
      onError?: (err: Error) => void;
      /** Resume CURSOR — a position from `onPosition` or an event id (`evt_…`), NOT a timestamp. See {@link MailsClient.stream}. */
      since?: string;
      /** The stream's position each time it moves, to save and pass back as `since`. */
      onPosition?: (position: string) => void;
      signal?: AbortSignal;
    }
  ): AbortController {
    return this.subscribe(["reply.received"], callback, opts);
  }

  /**
   * Subscribe to cold/first-contact inbound (`message.received`) for this agent —
   * new senders that are NOT replying to one of your sends. Same shape and
   * agent-scoping as {@link onReply}; returns an AbortController.
   *
   * @example
   *   const ctrl = agent.onMessage((event) => {
   *     if (event.intent === "schedule_demo") routeToCrm(event);
   *   });
   */
  onMessage(
    callback: (event: InboundEvent) => void | Promise<void>,
    opts?: {
      onError?: (err: Error) => void;
      /** Resume CURSOR — a position from `onPosition` or an event id (`evt_…`), NOT a timestamp. See {@link MailsClient.stream}. */
      since?: string;
      /** The stream's position each time it moves, to save and pass back as `since`. */
      onPosition?: (position: string) => void;
      signal?: AbortSignal;
    }
  ): AbortController {
    return this.subscribe(["message.received"], callback, opts);
  }

  /** Shared agent-scoped SSE subscription used by onReply/onMessage. */
  private subscribe(
    eventTypes: InboundEventType[],
    callback: (event: InboundEvent) => void | Promise<void>,
    opts?: { onError?: (err: Error) => void; since?: string; onPosition?: (position: string) => void; signal?: AbortSignal }
  ): AbortController {
    const report = (err: unknown) => {
      try {
        opts?.onError?.(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* the caller's own onError threw; nothing more to tell it */
      }
    };
    // A listener whose agent cannot be found (a typo, an agent not made yet, a name two agents
    // share) delivers nothing. With no onError that is said once on console.error, never
    // nowhere: until 2026-10-06 such a listener stayed silent for good.
    let told = false;
    return this.client.stream({
      event_types: eventTypes,
      since: opts?.since,
      signal: opts?.signal,
      onError: opts?.onError,
      onPosition: opts?.onPosition,
      onEvent: async (event) => {
        if (!this._id) {
          try {
            this._id = await this.resolveId();
          } catch (err) {
            if (opts?.onError) report(err);
            else if (!told) {
              told = true;
              console.error(`mails.ai agent listener stopped delivering: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
        }
        try {
          if (event.agent_id && event.agent_id !== this._id) return;
          // The stream sends only the inbound types asked for (event_types).
          await callback(event as InboundEvent);
        } catch (err) {
          report(err);
        }
      },
    });
  }

  private async resolveId(): Promise<string> {
    // The agent's id from its name, through the route that resolves a name as every other
    // call does (GET /v1/agents/{name}); cached on the instance, so later events skip the
    // round trip. Until 2026-10-06 this read the first 100 agents and took the first with the
    // name: an agent past the first page was "not found", and of two agents sharing a name
    // (one on a custom domain) the first listed won, where the API answers 409.
    try {
      return (await this.client.agents.get(this.name)).id;
    } catch (err) {
      if (err instanceof MailsError && err.code === "agent_not_found") {
        throw new Error(`Agent "${this.name}" not found in this workspace. Create it with createClient().agents.create("${this.name}") or check the name.`);
      }
      throw err;
    }
  }
}

// Verify an X-Mails-Signature header (t=<unix>,v1=<hex>) and parse the event. The header
// carries one `v1` per signing secret in force: two for 24 hours after a secret rotation, so
// a match against ANY of them verifies. Returns null when expired, unsigned or malformed.
function verifyWebhook(body: string, signature: string, secret: string, toleranceSec: number): TypedEvent | null {
  try {
    const pairs = signature.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? ["", ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
    const ts = parseInt(pairs.find(([k]) => k === "t")?.[1] ?? "", 10);
    if (!Number.isFinite(ts)) return null;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return null;
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"), "hex");
    const ok = pairs.some(([k, v]) => {
      if (k !== "v1") return false;
      const got = Buffer.from(v, "hex");
      return got.length === expected.length && crypto.timingSafeEqual(expected, got);
    });
    if (!ok) return null;
    return JSON.parse(body) as TypedEvent;
  } catch {
    return null;
  }
}

export function createClient(opts: ClientOptions = {}): MailsClient {
  return new MailsClient(opts);
}

// Default singleton — uses env vars. Safe to import even without keys; throws on first use.
export const mails = {
  agent(name: string, opts?: ClientOptions): Agent {
    return new MailsClient(opts ?? {}).agent(name);
  },
  // Object-literal members can't carry TS overload signatures, so this takes a union and
  // narrows. Both call shapes work: mails.send({to,subject,body}) and the original
  // mails.send("sarah", {to,subject,body}).
  send: ((
    agentOrInput: string | SendInput,
    inputOrOpts?: SendInput | ClientOptions,
    maybeOpts?: ClientOptions
  ): Promise<SendResult> => {
    if (typeof agentOrInput === "string") {
      return new MailsClient(maybeOpts ?? {}).send(agentOrInput, inputOrOpts as SendInput);
    }
    return new MailsClient((inputOrOpts as ClientOptions) ?? {}).send(agentOrInput);
  }) as {
    (input: SendInput, opts?: ClientOptions): Promise<SendResult>;
    (agent: string, input: SendInput, opts?: ClientOptions): Promise<SendResult>;
  },
  webhooks: {
    verify(body: string, signature: string, secret: string, toleranceSec = 300): TypedEvent | null {
      return verifyWebhook(body, signature, secret, toleranceSec);
    },
  },
};

export { MailsClient, Agent, MailsError, RateLimitError };
