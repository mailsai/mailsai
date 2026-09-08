// @mailsai/sdk — TypeScript client for the Mails.ai API.
// 6 lines to give an AI agent a working email primitive:
//
//   import { mails } from "@mailsai/sdk";
//   const sarah = mails.agent("sarah");
//   await sarah.send({ to: "lead@acme.com", subject: "Demo", body: "Hi…" });

import crypto from "crypto";

export type ClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type Tag = { name: string; value: string };

export type Attachment = { filename: string; content_base64: string; content_type: string };

export type SendInput = {
  /** The agent to send as. OPTIONAL since 0.1.2 — omit it and the workspace's single
   *  agent is used, or one is created on the spot (named from `from`). Only needed when
   *  a workspace has SEVERAL agents and you must say which. */
  agent?: string;
  /** The sender you want — a handle or an address. `"billing"`, `"billing@acme.com"` and
   *  `"Acme <billing@acme.com>"` all mean the agent called `billing`.
   *
   *  It SELECTS that agent: resolved if it exists, created if it doesn't, and refused with
   *  402 `plan_limit_exceeded` if your plan has no room for another one. It is never
   *  resolved to a DIFFERENT agent — read `SendResult.from` for the address that actually
   *  sent. It also cannot spoof a sender: the wire From always derives from the agent's own
   *  identity. Lets you write the same call you'd write for any email API. */
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
  /** Up to 10 attachments, base64-encoded. */
  attachments?: Attachment[];
  metadata?: Record<string, string>;
  pool_hint?: "clean" | "mixed";
  scheduled_at?: string;
  tags?: Tag[];
  idempotency_key?: string;
};

export type SendResult = {
  id: string;
  agent_id: string;
  /**
   * The agent address this was actually sent as — the resolved `from`.
   *
   * Worth reading when you pass `from` as a naming hint rather than an explicit `agent`:
   * it is the receipt for which identity the API picked. Returned by send, list and get
   * alike. (Recipients reply to this address; the wire From rides the shared sending
   * domain, which is what makes multi-tenant agent mail deliverable.)
   */
  from?: string;
  thread_id?: string;
  to: string[];
  subject: string;
  routing_pool: "clean" | "mixed" | "outbound";
  classifier_score: number;
  status: "queued" | "scheduled" | "sent";
  cost_usd: number;
  scheduled_at?: string;
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
};

export type ForwardInput = {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
};

export type ListResult<T> = { data: T[]; has_more: boolean; next_cursor?: string };

export type TypedEvent = {
  id: string;
  /**
   * Event type. Inbound: `reply.received` (a genuine reply to one of your sends),
   * `message.received` (an authenticated cold/first-contact inbound — NOT a reply),
   * `message.received.unauthenticated` (SPF+DKIM both failed). Outbound lifecycle:
   * `message.sent` / `message.delivered` / `message.bounced` / `message.complained` /
   * `message.scheduled`. Plus `suppression.added`, `agent.paused`/`agent.resumed`,
   * and `draft.*`. Use `agent.onReply` for replies and `agent.onMessage` for cold inbound.
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
   * threshold. `injection_score` is the evidence; this is the decision — gate on it and
   * you inherit our threshold rather than picking one yourself.
   *
   * ```ts
   * agent.onMessage((e) => { if (e.quarantined) return; act(e); });
   * ```
   *
   * Inbound events only (`message.received`, `reply.received`); `undefined` on outbound
   * lifecycle events.
   */
  quarantined?: boolean;
  entities?: Record<string, unknown>;
  /** Only present on SSE stream events for some types; on list/get read `data.thread_id`. */
  thread_id?: string;
  test_mode: boolean;
  data: Record<string, unknown>;
  created_at: string | null;
};

export type AgentRow = {
  id: string;
  name: string;
  email: string;
  domain: string;
  workspace_id: string;
  status: "active" | "paused" | "archived";
  created_at: string | null;
};

export type ThreadRow = {
  id: string;
  agent_id: string;
  subject?: string;
  last_message_at?: string;
  message_count: number;
  participants: string[];
  labels: string[];
  status: "open" | "closed" | "archived";
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
        snippet: string;
        received_at: string;
        created_at: string | null;
      }
  >;
};

export type ReceivedMessage = {
  id: string;
  agent_id: string;
  thread_id?: string;
  from: { address: string; name?: string };
  to: string;
  subject?: string;
  extracted_text?: string;
  body_text_excerpt?: string;
  spf_pass?: boolean;
  dkim_pass?: boolean;
  received_at: string;
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

export type WebhookRow = {
  id: string;
  url: string;
  event_types: string[];
  description: string | null;
  active: boolean;
  created_at: string | null;
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
    webhook_deliveries: number;
    sends_cost_usd: number;
    parses_cost_usd: number;
  };
  caps: { monthly_sends: number; monthly_parses: number; agents: number | "unlimited"; hourly: number; daily: number };
};

const DEFAULT_BASE = "https://api.mails.ai";
// Bounded exponential backoff for transient failures (429 / retry-safe 5xx).
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;

class MailsError extends Error {
  type: string;
  code: string;
  status: number;
  requestId?: string;
  param?: string;
  constructor(opts: { type: string; code: string; message: string; status: number; requestId?: string; param?: string }) {
    super(opts.message);
    this.name = "MailsError";
    this.type = opts.type;
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.param = opts.param;
  }
}

class MailsClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  messages: MessagesResource;
  received: ReceivedResource;
  threads: ThreadsResource;
  drafts: DraftsResource;
  events: EventsResource;
  agents: AgentsResource;
  suppression: SuppressionResource;
  api_keys: ApiKeysResource;
  webhooks: WebhooksResource;
  reputation: ReputationResource;
  billing: BillingResource;
  logs: LogsResource;

  constructor(opts: ClientOptions = {}) {
    const envKey = typeof process !== "undefined" ? process.env?.MAILS_API_KEY : undefined;
    const envBase = typeof process !== "undefined" ? process.env?.MAILS_BASE_URL : undefined;
    this.apiKey = opts.apiKey ?? envKey ?? "";
    this.baseUrl = (opts.baseUrl ?? envBase ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    if (!this.apiKey) {
      throw new Error("Mails.ai SDK: apiKey not provided and MAILS_API_KEY env var not set.");
    }

    this.messages = new MessagesResource(this);
    this.received = new ReceivedResource(this);
    this.threads = new ThreadsResource(this);
    this.drafts = new DraftsResource(this);
    this.events = new EventsResource(this);
    this.agents = new AgentsResource(this);
    this.suppression = new SuppressionResource(this);
    this.api_keys = new ApiKeysResource(this);
    this.webhooks = new WebhooksResource(this);
    this.reputation = new ReputationResource(this);
    this.billing = new BillingResource(this);
    this.logs = new LogsResource(this);
  }

  agent(name: string): Agent {
    return new Agent(this, name);
  }

  /** send({ to, subject, body }) — the agent is resolved or created for you. */
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

  // Raw helpers used by resources
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headersIn?: Record<string, string>
  ): Promise<T> {
    return this._request<T>(method, path, body, headersIn);
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    headersIn?: Record<string, string>
  ): Promise<T> {
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
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      const retryable =
        attempt < MAX_RETRIES && (res.status === 429 || (res.status >= 500 && (idempotentMethod || hasIdemKey)));
      if (retryable) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      let err: { error?: { type?: string; code?: string; message?: string; param?: string } } = {};
      try {
        err = await res.json();
      } catch {
        /* ignore */
      }
      throw new MailsError({
        type: err.error?.type ?? "api_error",
        code: err.error?.code ?? "unknown",
        message: err.error?.message ?? `${method} ${path} failed with ${res.status}`,
        status: res.status,
        requestId,
        param: err.error?.param,
      });
    }
  }

  async requestText(method: string, path: string, body?: unknown, headersIn?: Record<string, string>): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(headersIn ?? {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let err: { error?: { type?: string; code?: string; message?: string } } = {};
      try {
        err = await res.json();
      } catch {
        /* ignore */
      }
      throw new MailsError({
        type: err.error?.type ?? "api_error",
        code: err.error?.code ?? "unknown",
        message: err.error?.message ?? `${method} ${path} failed with ${res.status}`,
        status: res.status,
      });
    }
    return await res.text();
  }

  /**
   * SSE live tail. Returns an AbortController; the caller closes it via `.abort()`.
   *
   * ⚠ `since` here is an **event ID** (`evt_…`) — a resume CURSOR, not a timestamp. That is
   * the opposite of `events.list({ since })`, which takes an ISO timestamp. Passing a
   * timestamp to the stream does not error; it silently replays from the beginning, because
   * every `evt_…` id sorts after a `2026-…` string. Resume a dropped stream by passing the
   * last event id you actually processed.
   */
  stream(opts: { since?: string; event_types?: string[]; onEvent: (e: TypedEvent) => void; onError?: (err: Error) => void; signal?: AbortSignal }): AbortController {
    const ctrl = new AbortController();
    if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort());
    const qs = new URLSearchParams();
    if (opts.since) qs.set("since", opts.since);
    if (opts.event_types) qs.set("event_types", opts.event_types.join(","));
    const url = `${this.baseUrl}/api/v1/events/stream${qs.toString() ? "?" + qs.toString() : ""}`;
    void (async () => {
      try {
        const res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          opts.onError?.(new Error(`stream HTTP ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              try {
                const evt = JSON.parse(dataLine.slice(6)) as TypedEvent;
                opts.onEvent(evt);
              } catch {
                /* ignore parse errors */
              }
            }
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted) opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return ctrl;
  }
}

class MessagesResource {
  constructor(private c: MailsClient) {}
  /** send({ to, subject, body }) — the agent is resolved or created for you. */
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
    };
    const headers: Record<string, string> = {};
    if (input.idempotency_key) headers["Idempotency-Key"] = input.idempotency_key;
    return this.c.request("POST", "/api/v1/messages", body, headers);
  }
  batch(messages: Array<Omit<SendInput, "idempotency_key"> & { agent: string }>, opts?: { idempotency_key?: string }) {
    const headers: Record<string, string> = {};
    if (opts?.idempotency_key) headers["Idempotency-Key"] = opts.idempotency_key;
    return this.c.request<{ data: Array<SendResult | { error: { type: string; code: string; message: string } }>; batch_size: number }>(
      "POST",
      "/api/v1/messages/batch",
      messages,
      headers
    );
  }
  reply(id: string, input: ReplyInput) {
    return this.c.request<SendResult & { in_reply_to_message_id: string }>(
      "POST",
      `/api/v1/messages/${encodeURIComponent(id)}/reply`,
      { ...input, body_text: input.body_text ?? input.body }
    );
  }
  forward(id: string, input: ForwardInput) {
    return this.c.request<SendResult & { forwarded_from: string }>(
      "POST",
      `/api/v1/messages/${encodeURIComponent(id)}/forward`,
      input
    );
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
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; thread_id?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.thread_id) qs.set("thread_id", opts.thread_id);
    return this.c.request<ListResult<SendResult>>(
      "GET",
      `/api/v1/messages${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<SendResult>("GET", `/api/v1/messages/${encodeURIComponent(id)}`);
  }
}

class ReceivedResource {
  constructor(private c: MailsClient) {}
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; thread_id?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.thread_id) qs.set("thread_id", opts.thread_id);
    return this.c.request<ListResult<ReceivedMessage>>(
      "GET",
      `/api/v1/messages/received${qs.toString() ? "?" + qs.toString() : ""}`
    );
  }
  get(id: string) {
    return this.c.request<ReceivedMessage & { raw_url: string }>(
      "GET",
      `/api/v1/messages/received/${encodeURIComponent(id)}`
    );
  }
}

class ThreadsResource {
  constructor(private c: MailsClient) {}
  list(opts?: { limit?: number; cursor?: string; agent_id?: string; status?: "open" | "closed" | "archived" }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.status) qs.set("status", opts.status);
    return this.c.request<ListResult<ThreadRow>>("GET", `/api/v1/threads${qs.toString() ? "?" + qs.toString() : ""}`);
  }
  get(id: string) {
    return this.c.request<ThreadDetail>("GET", `/api/v1/threads/${encodeURIComponent(id)}`);
  }
  update(id: string, patch: { labels?: string[]; status?: "open" | "closed" | "archived" }) {
    return this.c.request<ThreadRow>("PATCH", `/api/v1/threads/${encodeURIComponent(id)}`, patch);
  }
}

class DraftsResource {
  constructor(private c: MailsClient) {}
  create(input: {
    agent: string;
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
  }) {
    return this.c.request<DraftRow>("POST", "/api/v1/drafts", input);
  }
  list(opts?: { limit?: number; cursor?: string; status?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
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
  send(id: string, opts?: { send_at?: string }) {
    return this.c.request<{ id: string; status: string; message_id?: string; thread_id?: string; sent_at?: string; send_at?: string }>(
      "POST",
      `/api/v1/drafts/${encodeURIComponent(id)}/send`,
      opts ?? {}
    );
  }
}

class EventsResource {
  constructor(private c: MailsClient) {}
  list(opts?: { limit?: number; cursor?: string; event_type?: string; agent_id?: string; since?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.event_type) qs.set("event_type", opts.event_type);
    if (opts?.agent_id) qs.set("agent_id", opts.agent_id);
    if (opts?.since) qs.set("since", opts.since);
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
  stream(opts: { since?: string; event_types?: string[]; onEvent: (e: TypedEvent) => void; onError?: (err: Error) => void }) {
    return this.c.stream(opts);
  }
}

class AgentsResource {
  constructor(private c: MailsClient) {}
  create(
    name: string,
    opts?: {
      domain?: string;
      allowlist_domains?: string[];
      blocklist_domains?: string[];
      /**
       * Run the costed LLM intent/entity extractor on this agent's inbound. The
       * prompt-injection scan ALWAYS runs regardless; this only gates the extra
       * classification pass (the metered "classify (opt-in)"). Default false.
       */
      classify_inbound?: boolean;
    }
  ) {
    return this.c.request<AgentRow>("POST", "/api/v1/agents", { name, ...opts });
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
    patch: { status?: "active" | "paused"; daily_send_limit?: number | null; hourly_send_limit?: number | null; allowlist_domains?: string[]; blocklist_domains?: string[]; classify_inbound?: boolean }
  ) {
    return this.c.request<AgentRow>("PATCH", `/api/v1/agents/${encodeURIComponent(id)}`, patch);
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
  list(opts?: { limit?: number; cursor?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    return this.c.request<ListResult<{ id: string; address: string; attestation: string; created_at: string }>>(
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
    scopes?: ("send" | "read" | "manage")[];
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
  update(id: string, patch: { url?: string; event_types?: string[]; description?: string; active?: boolean }) {
    return this.c.request<WebhookRow>("PATCH", `/api/v1/webhooks/${encodeURIComponent(id)}`, patch);
  }
  /** Send a signed test event to the endpoint to verify reachability + signature handling. */
  test(id: string) {
    return this.c.request<{ ok: boolean; http_status?: number; error?: string }>(
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
    try {
      const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=") as [string, string]));
      const ts = parseInt(parts.t ?? "0", 10);
      if (!Number.isFinite(ts)) return null;
      if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return null;
      const expected = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts.v1 ?? "", "hex"));
      if (!ok) return null;
      return JSON.parse(body) as TypedEvent;
    } catch {
      return null;
    }
  }
}

class ReputationResource {
  constructor(private c: MailsClient) {}
  get(agentId?: string) {
    const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    return this.c.request<{
      agent_id?: string;
      workspace_id?: string;
      reputation: number;
      send_count_30d?: number;
      bounce_count_30d?: number;
      complaint_count_30d?: number;
      reply_count_30d?: number;
    }>("GET", `/api/v1/reputation${qs}`);
  }
}

class BillingResource {
  constructor(private c: MailsClient) {}
  portal(returnUrl?: string) {
    return this.c.request<{ url: string; mock: boolean }>(
      "POST",
      "/api/v1/billing/portal",
      { return_url: returnUrl }
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
  async listReplies(opts?: { limit?: number; since?: string }) {
    return this.client.events.list({ event_type: "reply.received", agent_id: this.name, ...opts });
  }
  /**
   * List cold/first-contact inbound (`message.received`) for this agent — messages
   * from senders that are NOT replies to one of your sends (new leads, support
   * requests, strangers). Authenticated only; SPF+DKIM failures surface separately
   * as `message.received.unauthenticated`. Mirrors {@link listReplies}.
   */
  async listMessages(opts?: { limit?: number; since?: string }) {
    return this.client.events.list({ event_type: "message.received", agent_id: this.name, ...opts });
  }
  async reputation() {
    return this.client.reputation.get(this.name);
  }

  /**
   * Subscribe to reply.received events for this agent. Opens an SSE stream
   * filtered server-side to reply.received and dispatches to `callback` for
   * events matching this agent. Resolves the agent name → id once on first
   * matching event so subsequent events skip the lookup.
   *
   * @returns AbortController — call `.abort()` to stop listening. Caller can
   *   also pass `opts.signal` to chain into an existing abort flow.
   *
   * @example
   *   const ctrl = agent.onReply((event) => {
   *     console.log(event.intent, event.entities);
   *   });
   *   // …later
   *   ctrl.abort();
   */
  onReply(
    callback: (event: TypedEvent) => void | Promise<void>,
    opts?: {
      onError?: (err: Error) => void;
      /** Resume CURSOR — an event id (`evt_…`), NOT a timestamp. See {@link MailsClient.stream}. */
      since?: string;
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
   *     if (event.intent === "sales_inquiry") routeToCrm(event);
   *   });
   */
  onMessage(
    callback: (event: TypedEvent) => void | Promise<void>,
    opts?: {
      onError?: (err: Error) => void;
      /** Resume CURSOR — an event id (`evt_…`), NOT a timestamp. See {@link MailsClient.stream}. */
      since?: string;
      signal?: AbortSignal;
    }
  ): AbortController {
    return this.subscribe(["message.received"], callback, opts);
  }

  /** Shared agent-scoped SSE subscription used by onReply/onMessage. */
  private subscribe(
    eventTypes: string[],
    callback: (event: TypedEvent) => void | Promise<void>,
    opts?: { onError?: (err: Error) => void; since?: string; signal?: AbortSignal }
  ): AbortController {
    return this.client.stream({
      event_types: eventTypes,
      since: opts?.since,
      signal: opts?.signal,
      onError: opts?.onError,
      onEvent: async (event) => {
        try {
          if (!this._id) this._id = await this.resolveId();
          if (event.agent_id && event.agent_id !== this._id) return;
          await callback(event);
        } catch (err) {
          opts?.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
  }

  private async resolveId(): Promise<string> {
    // Look up the agent's UUID by friendly name. Cached on the instance so
    // subsequent matches in the stream skip the round-trip.
    const list = await this.client.agents.list({ limit: 100 });
    const found = list.data.find((a) => a.name === this.name);
    if (!found) {
      throw new Error(
        `Agent "${this.name}" not found in this workspace. Create it with mails.agents.create("${this.name}") or verify the name.`
      );
    }
    return found.id;
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
      try {
        const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=") as [string, string]));
        const ts = parseInt(parts.t ?? "0", 10);
        if (!Number.isFinite(ts)) return null;
        if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return null;
        const expected = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
        const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts.v1 ?? "", "hex"));
        if (!ok) return null;
        return JSON.parse(body) as TypedEvent;
      } catch {
        return null;
      }
    },
  },
};

export { MailsClient, Agent, MailsError };
