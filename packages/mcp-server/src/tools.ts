// @mailsai/mcp-server — every tool, transport-agnostic.
//
// One source of truth for BOTH transports: the stdio server (src/index.ts, `npx @mailsai/mcp-server`,
// key from MAILS_API_KEY) and the hosted Streamable-HTTP endpoint at https://api.mails.ai/mcp
// (mails-api app/api/mcp/route.ts, key or sign-in token from the request's Bearer). Both build
// their server with createMailsMcpServer (server.ts) from what this file exports. Until 2026-09-09
// the hosted form did not exist, and three of the directories that matter (Smithery, the Claude
// connectors directory, the ChatGPT plugins directory) refuse to list an install-only server.
//
// Two kinds of tool:
//   - the 20 hand-written ones below. Clients have their arguments saved, so those never change;
//     optional arguments are added only where the API grew.
//   - one generated tool for every other operation in the API's OpenAPI document
//     (generated/tools.ts, written by scripts/gen-mcp-tools.ts; `npm run check:mcp-tools` fails
//     when it falls behind the document or the route files).
// Every tool calls the REST API with the caller's own credential, so the API's own checks
// (scopes, keys tied to one agent, connected apps, plan limits) apply to every call. The tool
// LIST is narrowed to what the credential may call (toolsFor), and a call to anything else is
// refused before it is made (refusal).
//
// Names are `mails_<words>`. Until 0.3.0 they were `mails.<words>`, which Claude's API and
// OpenAI's refuse as a tool name (letters, digits, `_` and `-` only), so three of the framework
// guides failed on their first model call. A call by the old name is still answered (toolNamed);
// the list never shows one, since a single dotted name there breaks those frameworks again.
import { API_ARG_TEXT, GENERATED_TOOLS, HANDWRITTEN_ROUTES, MCP_SERVER_VERSION, ROUTE_FACTS } from "./generated/tools.ts";
import type { Credential, GeneratedTool, InputSchema, RouteFacts, ToolContent, ToolDefinition, ToolHints, ToolResult } from "./types.ts";

export type { Credential, ToolContent, ToolDefinition, ToolResult } from "./types.ts";
export { MCP_SERVER_VERSION };

export type ToolContext = {
  apiKey: string;
  baseUrl?: string;
  /** Who is calling, when the transport knows. A call this credential may not make is refused
   *  before it is sent, and mails_me counts the tools from it (without it, from GET /v1/me). */
  credential?: Credential | null;
  /** Aborts the API calls when the client cancels the tool call. */
  signal?: AbortSignal;
};

/** One tool as the registry holds it: what `tools/list` sends, plus where it is listed and
 *  what a credential needs before it may call it. */
export type ToolSpec = ToolDefinition & { group: string; route: string; facts: RouteFacts };

/** Sent with `initialize`. Facts about the server, never instructions to the model. */
export const SERVER_INSTRUCTIONS =
  "mails.ai gives an AI agent its own email address: it sends, receives and replies, and mail received within the plan's limits is scanned for prompt injection " +
  "and carries a score from 0 to 1 (at 0.95 or above it is marked quarantined). A message that was never classified (parse_status pending, " +
  "failed or quota_skipped) carries a null score and a null quarantined instead: it was not scanned. " +
  "The tools listed are the ones this connection's credential may use: without the send scope " +
  "there are no sending tools, and the sandbox tool appears only for a test key (mk_test_…), which runs the whole pipeline and sends nothing. " +
  "reply@test.mails.ai answers a message within about a second, at most 3 times in one thread (a 4th message there gets no reply), " +
  "and its answers appear in mails_list_replies.";

const DEFAULT_BASE = "https://api.mails.ai";
const READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Mail cannot be unsent: every tool that sends is destructive as well as open-world.
const SENDS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

type Args = Record<string, unknown>;
type Api = ReturnType<typeof makeApi>;
type HandTool = {
  name: string;
  title: string;
  description: string;
  group: string;
  inputSchema: InputSchema;
  hints: ToolHints;
  run: (a: Args, api: Api, ctx: ToolContext) => Promise<unknown>;
};

const toList = { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
const idempotencyKeyArg = {
  type: "string",
  maxLength: 255,
  description:
    "Any string up to 255 characters: a call repeated with the same key returns the first answer instead of sending twice. Without it, the call gets a key of its own.",
};
const listUnsubscribeArg = {
  type: "boolean",
  description:
    "Adds RFC 8058 one-click unsubscribe headers (List-Unsubscribe and List-Unsubscribe-Post), for newsletters, digests and other recurring mail. One click suppresses the address for the whole workspace. The message needs exactly one recipient: one `to`, and no cc or bcc.",
};
const tagsArg = { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } } };

/** The 20 tools clients have saved since 0.1. Arguments never change; the names are 0.2's with
 *  `_` for `.`, and the old ones still answer (toolNamed). */
const HAND_TOOLS: HandTool[] = [
  {
    name: "mails_send",
    title: "Send an email",
    group: "Sent mail",
    description:
      "Send an email. `agent` is OPTIONAL: without it the workspace's single agent is used, or one is created (named from `from`) when this connection may create agents (Full access, or a key with `manage`), so a first send needs no setup; with several agents, `agent` says which one sends. The reputation firewall runs on every send: an agent auto-suspended for crossing a 0.3% complaint rate is blocked (422 agent_paused), a send with a suppressed address in to, cc or bcc is refused whole (422 recipient_suppressed), and the response returns the classifier_score, which shows how the send was graded.",
    hints: SENDS,
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Optional. The agent to send as; without it the workspace's default is used, or created when this connection may create agents. When it is given it decides the sender: a `from` beside it picks no agent and creates none.",
        },
        from: {
          type: "string",
          description:
            "Optional. The sender you want, as a handle or address — \"billing\", \"billing@acme.com\" and \"Acme <billing@acme.com>\" all mean the agent called \"billing\". It SELECTS that agent: resolved if it exists. If it does not, it is created when this connection may create agents (Full access, or a key with `manage`) and the plan has room; otherwise the send is refused, with 403 insufficient_scope or, when the plan has no room, 402 plan_limit_exceeded. It is never resolved to a DIFFERENT agent, and it cannot spoof a sender. Beside an explicit `agent` it selects nothing: `agent` decides the sender. Either way a display name in it, like Acme above, goes on the From line, a scheduled send's too. The address that actually sent comes back as `from` on the result.",
        },
        to: toList,
        subject: { type: "string" },
        body_text: { type: "string" },
        body_html: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        reply_to: { type: "string" },
        in_reply_to_message_id: { type: "string" },
        references: { type: "array", items: { type: "string" }, description: "RFC Message-IDs to thread into" },
        attachments: {
          type: "array",
          description:
            "Up to 10 files, 25 MB in all. Each has a filename and either content_base64 (with content_type) or path, an https URL mails.ai downloads when it sends (content_type optional). Files given as content_base64 travel inside the request, so together they can come to about 3 MB: give a larger one by path. A file with content_id is shown inside body_html where it says cid:<content_id>, instead of being attached. Not with a future scheduled_at: a scheduled send cannot carry attachments yet (400).",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content_base64: { type: "string", description: "The file's bytes, base64. Give this or path, not both." },
              path: {
                type: "string",
                description:
                  "An https URL fetched at send time: it must answer within 10 seconds, after at most 3 redirects, at a public address. A file that cannot be fetched refuses the send (400 invalid_field, param attachments.N.path).",
              },
              content_type: { type: "string", description: "MIME type. Required with content_base64; with path, the type the URL answers with is used." },
              content_id: { type: "string", description: 'Show the file inside the HTML: <img src="cid:logo"> shows the file whose content_id is "logo".' },
            },
          },
        },
        metadata: { type: "object", additionalProperties: { type: "string" } },
        scheduled_at: { type: "string", description: "ISO 8601 future timestamp. A future time cannot be combined with attachments." },
        tags: tagsArg,
        list_unsubscribe: listUnsubscribeArg,
        idempotency_key: idempotencyKeyArg,
      },
      required: ["to", "subject"],
    },
    run: (a, api) =>
      // `agent` is optional since 0.2.3: omitted, the API resolves the workspace's single agent
      // or provisions one named from `from`, so it is passed through as given, never defaulted.
      api.json("POST", "/v1/messages", {
        body: pick(a, [
          "agent", "from", "to", "cc", "bcc", "subject", "body_text", "body_html", "reply_to", "in_reply_to_message_id",
          "references", "attachments", "metadata", "scheduled_at", "tags", "list_unsubscribe",
        ]),
        idempotencyKey: keyFor(a),
      }),
  },
  {
    name: "mails_reply",
    title: "Reply to an email",
    group: "Sent mail",
    description:
      "Reply in-thread to a message. A received message (rcv_…) is answered to its sender, or to the Reply-To address it named; one of your own sent messages (msg_…) is followed up to its recipients. In-Reply-To, References and the Re: subject are set server-side, and the original is not quoted.",
    hints: SENDS,
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "msg_xxx or rcv_xxx" },
        body_text: { type: "string" },
        body_html: { type: "string" },
        reply_all: { type: "boolean" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        tags: tagsArg,
        scheduled_at: { type: "string", description: "ISO 8601 future timestamp: the reply is sent then instead of now." },
        list_unsubscribe: listUnsubscribeArg,
        idempotency_key: idempotencyKeyArg,
      },
      required: ["message_id"],
    },
    run: (a, api) =>
      api.json("POST", `/v1/messages/${segment(a.message_id, "message_id")}/reply`, {
        body: pick(a, ["body_text", "body_html", "reply_all", "cc", "bcc", "tags", "scheduled_at", "list_unsubscribe"]),
        idempotencyKey: keyFor(a),
      }),
  },
  {
    name: "mails_forward",
    title: "Forward an email",
    group: "Sent mail",
    description: "Forward a message to new recipients.",
    hints: SENDS,
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        to: toList,
        subject: { type: "string" },
        body_text: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        body_html: { type: "string" },
        list_unsubscribe: listUnsubscribeArg,
        idempotency_key: idempotencyKeyArg,
      },
      required: ["message_id", "to"],
    },
    run: (a, api) =>
      api.json("POST", `/v1/messages/${segment(a.message_id, "message_id")}/forward`, {
        body: pick(a, ["to", "subject", "body_text", "cc", "bcc", "body_html", "list_unsubscribe"]),
        idempotencyKey: keyFor(a),
      }),
  },
  {
    name: "mails_list_threads",
    title: "List threads",
    group: "Threads",
    description: "List threads (conversations) for the workspace or a specific agent.",
    hints: READ,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        status: { type: "string", enum: ["open", "closed", "archived"] },
        limit: { type: "number" },
        cursor: { type: "string" },
        folder: {
          type: "string",
          enum: ["inbox", "archive", "spam", "trash", "sent", "all"],
          description: "Which folder's threads to return, or `all`. Without it: every folder except trash.",
        },
        read: { type: "boolean", description: "false for unread threads only, true for read ones." },
        label: { type: "string", description: "Only threads carrying this label (a name, or a label id `lbl_…`)." },
        mode: {
          type: "string",
          enum: ["live", "test", "all"],
          description: "live for threads that hold live mail, test for threads of test mail only, all for both. Without it: the threads of this connection's own mode.",
        },
        q: {
          type: "string",
          description: "Case-insensitive text in the subject or the participants' addresses. For word search across all mail there is mails_search_mail.",
        },
      },
    },
    run: (a, api) => api.json("GET", "/v1/threads", { query: pick(a, ["agent_id", "status", "limit", "cursor", "folder", "read", "label", "mode", "q"]) }),
  },
  {
    name: "mails_get_thread",
    title: "Get a thread",
    group: "Threads",
    description: "Get a full thread with all messages in chronological order.",
    hints: READ,
    inputSchema: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] },
    run: (a, api) => api.json("GET", `/v1/threads/${segment(a.thread_id, "thread_id")}`),
  },
  {
    name: "mails_list_received",
    title: "List received emails",
    group: "Received mail",
    description: "List recently received messages. Text only: never the sender's HTML.",
    hints: READ,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        thread_id: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
        q: { type: "string", description: "Case-insensitive text in the subject, body or sender address." },
        from: {
          type: "string",
          description: "Only mail from this sender: an address, or a domain and its subdomains (github.com takes mail.github.com, never github.com.evil.example).",
        },
        to: {
          type: "string",
          description: "Only mail sent to this address, such as a plus address of the agent's receiving address (qa.acme+run-1842@in.mails.ai).",
        },
        since: { type: "string", description: "Only mail received at or after this ISO 8601 time." },
      },
    },
    run: (a, api) => {
      const query = pick(a, ["agent_id", "thread_id", "limit", "cursor", "q", "from", "to"]);
      if (a.since !== undefined) query.since = normalizeSince(a.since);
      return api.json("GET", "/v1/messages/received", { query });
    },
  },
  {
    name: "mails_get_received",
    title: "Get a received email",
    group: "Received mail",
    description: "Get one received message: its text, including the extracted reply text. Never its HTML.",
    hints: READ,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (a, api) => {
      // Text only. The HTML part is the sender's own markup, and a model reads whatever it
      // hides (a comment, an attribute) as instructions; the text parts carry the message.
      // GET /v1/messages/received/{id} still returns body_html to code that wants it.
      const msg = { ...((await api.json("GET", `/v1/messages/received/${segment(a.id, "id")}`)) as Args) };
      delete msg.body_html;
      delete msg.extracted_html;
      return msg;
    },
  },
  {
    name: "mails_list_agents",
    title: "List agents",
    group: "Agents",
    description:
      "List the agents in the workspace. Returns SENDABLE agents by default (status=live); archived agents cannot send, so they are excluded unless asked for: status=\"all\" includes them.",
    hints: READ,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        cursor: { type: "string" },
        status: { type: "string", enum: ["live", "all", "active", "paused", "archived"], description: "Default \"live\" = everything except archived." },
      },
    },
    run: (a, api) => api.json("GET", "/v1/agents", { query: pick(a, ["limit", "cursor", "status"]) }),
  },
  {
    name: "mails_create_agent",
    title: "Create an agent",
    group: "Agents",
    description:
      "Create a new agent: on the workspace's mails.ai address (`name`), or at an address on a domain the workspace has verified (`address`), with `forwarding: true` when the mail service that already hosts that address forwards its mail to the agent. Returns the agent, with its forwarding_address and forwarding_status in forwarding mode.",
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Required unless `address` is given." },
        domain: { type: "string" },
        address: {
          type: "string",
          description: "The agent's address, on a domain the workspace has verified for sending (support@acme.com). The agent is named after its local part.",
        },
        forwarding: {
          type: "boolean",
          description:
            "Forwarding mode: the mail service that already hosts `address` forwards its mail to the agent's forwarding_address, so no MX record changes. mails_agents_verify_forwarding tests the forward.",
        },
        allowlist_domains: {
          type: "array",
          items: { type: "string" },
          description:
            "When set, this agent sends only to these domains and their subdomains; any other recipient in to, cc or bcc refuses the send (422 recipient_not_allowed), test keys included.",
        },
        blocklist_domains: {
          type: "array",
          items: { type: "string" },
          description: "Domains (and their subdomains) this agent never sends to (422 recipient_not_allowed).",
        },
        // The API reference's own words, from the generated file (MIRRORED_ARGS).
        classify_inbound: { type: "boolean", description: API_ARG_TEXT["POST /v1/agents"].classify_inbound },
        daily_send_limit: {
          type: "integer",
          description:
            "The most recipients this agent's live sends reach in any 24 hours (each `to`, `cc` and `bcc` address once), on top of the plan's cap; past it a send gets 429 daily_limit_exceeded. Leave it out to use only the plan's cap.",
        },
        hourly_send_limit: {
          type: "integer",
          description:
            "The most recipients this agent's live sends reach in any hour (each `to`, `cc` and `bcc` address once), on top of the plan's cap; past it a send gets 429 hourly_limit_exceeded. Leave it out to use only the plan's cap.",
        },
      },
    },
    run: (a, api) =>
      api.json("POST", "/v1/agents", {
        body: pick(a, ["name", "domain", "address", "forwarding", "allowlist_domains", "blocklist_domains", "classify_inbound", "daily_send_limit", "hourly_send_limit"]),
      }),
  },
  {
    name: "mails_list_replies",
    title: "List replies",
    group: "Received mail",
    description:
      "List recent reply events (reply.received) for an agent. A reply that failed authentication is not a reply event: mails_list_messages lists it, as message.received.unauthenticated.",
    hints: READ,
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, limit: { type: "number" }, since: { type: "string" } },
      required: ["agent"],
    },
    run: (a, api) =>
      api.json("GET", "/v1/events", {
        query: { event_type: "reply.received", agent_id: a.agent, limit: a.limit ?? 10, since: normalizeSince(a.since) },
      }),
  },
  {
    name: "mails_list_messages",
    title: "List first-contact mail",
    group: "Received mail",
    description:
      "List recent cold/first-contact inbound (message.received) for an agent — senders that are NOT replying to one of your sends — together with mail that failed authentication (message.received.unauthenticated: its From domain's DMARC policy is quarantine or reject, and no DKIM signature aligned with that domain verifies), newest first. Each event carries `unauthenticated`, true for the failed ones.",
    hints: READ,
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, limit: { type: "number" }, since: { type: "string" } },
      required: ["agent"],
    },
    run: async (a, api) => {
      const limit = typeof a.limit === "number" && a.limit > 0 ? a.limit : 10;
      const query = { agent_id: a.agent, limit, since: normalizeSince(a.since) };
      const [authenticated, failed] = (await Promise.all([
        api.json("GET", "/v1/events", { query: { ...query, event_type: "message.received" } }),
        api.json("GET", "/v1/events", { query: { ...query, event_type: "message.received.unauthenticated" } }),
      ])) as Array<{ data?: Array<{ id: string }>; has_more?: boolean }>;
      // Event ids sort by time, as GET /v1/events orders them: one list, newest first.
      const merged = [
        ...(authenticated.data ?? []).map((e) => ({ ...e, unauthenticated: false })),
        ...(failed.data ?? []).map((e) => ({ ...e, unauthenticated: true })),
      ].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
      return { data: merged.slice(0, limit), has_more: Boolean(authenticated.has_more || failed.has_more || merged.length > limit) };
    },
  },
  {
    name: "mails_get_event",
    title: "Get an event",
    group: "Events",
    description:
      "Get one event by its id (evt_…), whatever its type: received mail, a send, a draft or a suppression. For received mail it also carries injection_categories, which the list leaves out.",
    hints: READ,
    inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    run: (a, api) => api.json("GET", `/v1/events/${segment(a.event_id, "event_id")}`),
  },
  {
    name: "mails_get_reputation",
    title: "Get an agent's sending reputation",
    group: "Account",
    description:
      "Get an agent's sending-reputation health (0-1) + its 30-day bounce/complaint/reply counts. The firewall auto-suspends an agent that crosses a 0.3% complaint rate. A key tied to one agent reads only that agent's reputation.",
    hints: READ,
    inputSchema: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
    run: async (a, api, ctx) => {
      const own = ctx.credential?.agentId;
      if (own) {
        // The key's own agent, through the route that resolves a name or an id. That route
        // answers such a key 404 for every other agent, as for one that does not exist (since
        // 2026-10-07), so both get these words rather than "Agent not found".
        const agent = (await api.json("GET", `/v1/agents/${segment(a.agent, "agent")}`).catch((err: unknown) => {
          if (err instanceof ApiCallError && err.status === 404) return null;
          throw err;
        })) as { id?: string } | null;
        if (agent?.id !== own) {
          throw new ApiCallError(`This API key is tied to one agent, and it reads only that agent's reputation, not ${String(a.agent)}'s.`);
        }
      }
      return api.json("GET", "/v1/reputation", { query: { agent_id: a.agent } });
    },
  },
  {
    name: "mails_check_suppression",
    title: "Check whether an address is suppressed",
    group: "Suppression",
    description: "Check if an address is suppressed.",
    hints: READ,
    inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    run: (a, api) => api.json("GET", "/v1/suppression", { query: { address: a.address } }),
  },
  {
    name: "mails_allowlist_address",
    title: "Allowlist a suppressed address",
    group: "Suppression",
    description:
      "Override a complaint or unsubscribe suppression for one address, with an attestation of at least 20 characters that the recipient agreed to receive the mail. A hard bounce is not lifted.",
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" }, attestation: { type: "string" } },
      required: ["address", "attestation"],
    },
    run: (a, api) => api.json("POST", "/v1/suppression/allow", { body: { address: a.address, attestation: a.attestation } }),
  },
  {
    name: "mails_create_draft",
    title: "Create a draft",
    group: "Drafts",
    description: "Stage a draft. With send_at it is scheduled.",
    // A scheduled draft sends mail later; until then it can be edited or deleted.
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        to: toList,
        subject: { type: "string" },
        body_text: { type: "string" },
        send_at: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        body_html: { type: "string" },
        reply_to: { type: "string" },
        in_reply_to_message_id: { type: "string" },
        tags: tagsArg,
        list_unsubscribe: listUnsubscribeArg,
      },
      required: ["agent", "to"],
    },
    run: (a, api) =>
      api.json("POST", "/v1/drafts", {
        body: pick(a, ["agent", "to", "subject", "body_text", "send_at", "cc", "bcc", "body_html", "reply_to", "in_reply_to_message_id", "tags", "list_unsubscribe"]),
      }),
  },
  {
    name: "mails_send_draft",
    title: "Send a draft",
    group: "Drafts",
    description: "Send a previously-created draft.",
    hints: SENDS,
    inputSchema: {
      type: "object",
      properties: { draft_id: { type: "string" }, send_at: { type: "string" }, idempotency_key: idempotencyKeyArg },
      required: ["draft_id"],
    },
    run: (a, api) => api.json("POST", `/v1/drafts/${segment(a.draft_id, "draft_id")}/send`, { body: pick(a, ["send_at"]), idempotencyKey: keyFor(a) }),
  },
  {
    name: "mails_get_usage",
    title: "Get billing-period usage",
    group: "Account",
    description: "Get the current billing period usage.",
    hints: READ,
    inputSchema: { type: "object", properties: {} },
    run: (_a, api) => api.json("GET", "/v1/billing/usage"),
  },
  {
    name: "mails_me",
    title: "Get the connected account",
    group: "Account",
    description: "Who am I — returns the authenticated workspace, agent, tier, and API-key scopes, with this server's version and how many tools this credential can use.",
    hints: READ,
    inputSchema: { type: "object", properties: {} },
    run: async (_a, api, ctx) => {
      const me = (await api.json("GET", "/v1/me")) as MeResponse;
      const credential = ctx.credential ?? credentialFromMe(me);
      return { ...me, mcp: { server_version: MCP_SERVER_VERSION, tools_available: toolsFor(credential).length } };
    },
  },
  {
    name: "mails_test_inbound",
    title: "Simulate a received email (test key)",
    group: "Received mail",
    description:
      "SANDBOX (test key only): simulate an email arriving to one of your agents, to exercise the whole two-way loop — receive → prompt-injection scan → reply — with NO live mail server and no waiting. This runs the REAL reputation firewall. The VERDICT is the top-level `quarantined` (boolean — true means we judged it an attack); the evidence sits in the `classification` block: injection_score (0-1), injection_categories, intent, entities, sender_reputation. A body_text that hides an instruction aimed at the agent, such as a request to forward its contacts to an outside address, is flagged by the injection scanner before it reaches the agent. A prior send's msg id as in_reply_to_message_id emits a reply.received event instead of a cold message.received.",
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent name or id the email is addressed to" },
        from: { type: "string", description: "sender email address" },
        to: { type: "string", description: "the address the email was sent to (default: the agent's receiving address); a plus address of it is allowed" },
        from_name: { type: "string" },
        subject: { type: "string" },
        body_text: { type: "string" },
        in_reply_to_message_id: { type: "string", description: "a prior test-send msg id → emits reply.received" },
        spf: { type: "string", enum: ["pass", "fail"] },
        dkim: { type: "string", enum: ["pass", "fail"], description: "spf AND dkim both 'fail' → message.received.unauthenticated" },
      },
      required: ["agent", "from", "body_text"],
    },
    run: (a, api) =>
      api.json("POST", "/v1/test/inbound", { body: pick(a, ["agent", "from", "to", "from_name", "subject", "body_text", "in_reply_to_message_id", "spf", "dkim"]) }),
  },
];

/** The order groups are listed in (README, dashboard). */
export const GROUP_ORDER = ["Sent mail", "Received mail", "Threads", "Drafts", "Agents", "Labels", "Search", "Events", "Webhooks", "Domains", "API keys", "Suppression", "Account"];

const handSpecs: ToolSpec[] = HAND_TOOLS.map((t) => {
  const route = HANDWRITTEN_ROUTES[t.name] ?? "";
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, ...t.hints },
    group: t.group,
    route,
    facts: ROUTE_FACTS[route] ?? {},
  };
});
const generatedSpecs: ToolSpec[] = GENERATED_TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
  group: t.group,
  route: t.route,
  facts: ROUTE_FACTS[t.route] ?? {},
}));

/** Every tool: the 20 hand-written ones first, then one for each remaining API operation. */
export const TOOLS: ToolSpec[] = [...handSpecs, ...generatedSpecs];
export const TOOLS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((t) => [t.name, t]));
/** The name a tool had until 0.3.0: `mails.send` for mails_send. */
export const legacyNameOf = (name: string): string => name.replace(/^mails_/, "mails.");
const BY_LEGACY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((t) => [legacyNameOf(t.name), t]));
/** The tool a call names: by its name, or by the dotted name it had until 0.3.0, which is never
 *  listed but still answered, so configs and prompts that saved one keep working. */
export const toolNamed = (name: string): ToolSpec | undefined => TOOLS_BY_NAME.get(name) ?? BY_LEGACY_NAME.get(name);
const HAND_BY_NAME = new Map(HAND_TOOLS.map((t) => [t.name, t]));
const GENERATED_BY_NAME = new Map(GENERATED_TOOLS.map((t) => [t.name, t]));

export const groupOf = (name: string): string => TOOLS_BY_NAME.get(name)?.group ?? "Other";

/** What `tools/list` sends for one tool. */
export const definitionOf = (t: ToolSpec): ToolDefinition => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
});

/** Why this credential may not call this tool, in words a person can act on; undefined when it
 *  may. A credential nobody could look up (null) is refused nothing: the API still decides. */
export function refusal(tool: Pick<ToolSpec, "name" | "facts">, credential: Credential | null | undefined): string | undefined {
  if (!credential) return undefined;
  const f = tool.facts;
  // Any one of the scopes that open the route will do (the draft routes take `draft` too), and
  // every scope it also needs must be there as well (rescheduling takes `send` beside `manage`).
  const opens = f.acceptedScopes?.length ? f.acceptedScopes : f.scope ? [f.scope] : [];
  const holds = (s: string) => credential.scopes.includes(s) || credential.scopes.includes("*");
  if ((opens.length && !opens.some(holds)) || (f.alsoNeeds ?? []).some((s) => !holds(s))) {
    const has = credential.scopes.length ? credential.scopes.map((s) => `\`${s}\``).join(", ") : "none";
    const needs = [opens.map((s) => `\`${s}\``).join(" or "), ...(f.alsoNeeds ?? []).map((s) => `\`${s}\``)].filter(Boolean);
    return `${tool.name} needs the ${needs.join(" and ")} scope${needs.length > 1 ? "s" : ""}, and this connection's scopes are ${has}.`;
  }
  if (f.testKeyOnly && credential.mode !== "test") return `${tool.name} works only with a test key (mk_test_…), and this connection is live.`;
  if (f.liveKeyOnly && credential.mode === "test") return `${f.liveKeyOnly.message} ${tool.name} is not offered to a test key.`;
  if (credential.connectedApp && f.connectedApps?.refused === "always") return f.connectedApps.message;
  if (credential.agentId) {
    // A route that refuses only some of that key's requests is shown: the API decides. The
    // reason is the route's own (lib/agent-scope.ts, read by the generator); until 2026-10-06 a
    // hand-kept list here named two routes that have since come to refuse such a key themselves.
    const why = f.agentKeys?.refused === "partly" ? undefined : f.agentKeys?.why;
    if (why) return `This API key is tied to one agent, and ${why}. ${tool.name} needs a key that is not tied to an agent.`;
  }
  return undefined;
}

/** The tools this credential may call: what `tools/list` answers it. */
export const toolsFor = (credential: Credential | null | undefined): ToolSpec[] => TOOLS.filter((t) => !refusal(t, credential));

/** The part of GET /v1/me the tool list depends on. */
export type MeResponse = { api_key?: { scopes?: string[]; mode?: string; agent_id?: string | null } };

/** The credential GET /v1/me describes. GET /v1/me does not tell an app connected by signing in
 *  from our own CLI, so it counts as ours: the API still refuses what it refuses. */
export function credentialFromMe(me: MeResponse): Credential | null {
  const k = me?.api_key;
  if (!k || !Array.isArray(k.scopes)) return null;
  return { scopes: k.scopes, mode: k.mode === "test" ? "test" : "live", agentId: k.agent_id ?? null, connectedApp: false };
}

/** Run one tool with a caller-supplied key. Never throws: errors come back as isError results,
 *  `Error: <message>`, exactly as the stdio server has always returned them. */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const spec = toolNamed(name);
    if (!spec) throw new ApiCallError(`Unknown tool: ${name}`);
    const why = refusal(spec, ctx.credential);
    if (why) throw new ApiCallError(why);
    const a = (args && typeof args === "object" ? args : {}) as Args;
    const api = makeApi(ctx);
    const hand = HAND_BY_NAME.get(spec.name);
    const out = hand ? await hand.run(a, api, ctx) : await runGenerated(GENERATED_BY_NAME.get(spec.name) as GeneratedTool, a, api);
    if (out instanceof Contents) return { content: out.blocks };
    return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(sanitize(out), null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** A tool answer that is not JSON text (an attachment's bytes). */
class Contents {
  constructor(readonly blocks: ToolContent[]) {}
}

class ApiCallError extends Error {
  /** The API's HTTP status, when the error is the API's answer. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const TEXT_LIMIT = 100_000;
const FILE_LIMIT = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_TYPES = new Set(["text/plain", "text/csv", "application/json", "text/markdown"]);

async function runGenerated(t: GeneratedTool, a: Args, api: Api): Promise<unknown> {
  let path = t.path;
  const query: Args = {};
  const body: Args = {};
  let whole: unknown;
  let idempotencyKey: string | undefined;
  for (const [arg, target] of Object.entries(t.args)) {
    const v = a[arg];
    if (target.in === "path") path = path.replace(`{${target.key}}`, segment(v, arg));
    else if (v === undefined) continue;
    else if (target.in === "query") query[target.key] = target.key === "since" ? normalizeSince(v) : v;
    else if (target.in === "header") idempotencyKey = String(v);
    else if (arg === t.bodyArg) whole = v;
    else body[target.key] = v;
  }
  if (t.idempotencyKey && !idempotencyKey) idempotencyKey = newKey();
  let waitSeconds: number | undefined;
  if (t.longPoll) {
    const n = Number(a[t.longPoll.arg] ?? t.longPoll.defaultSeconds);
    waitSeconds = Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  const opts = { query, body: t.sendsBody ? (t.bodyArg ? whole : body) : undefined, idempotencyKey, noAuth: ROUTE_FACTS[t.route]?.noAuth === true, waitSeconds };
  if (t.response === "json") return api.json(t.method, path, opts);
  if (t.response === "empty") {
    await api.send(t.method, path, opts);
    return { ok: true };
  }
  if (t.response === "text") {
    const res = await api.send(t.method, path, { ...opts, accept: "message/rfc822, text/plain, */*" });
    let text = await res.text();
    if (Object.entries(t.args).some(([arg, x]) => x.in === "path" && String(a[arg] ?? "").startsWith("rcv_"))) {
      // A received email's source carries the sender's HTML. Its text reaches a model through
      // mails_get_received; from here, only the header block.
      const end = text.search(/\r?\n\r?\n/);
      text = `${end >= 0 ? text.slice(0, end) : text}\n\n[The body of a received email is not returned here: mails_get_received returns its text.]`;
    }
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[Cut short: ${text.length - TEXT_LIMIT} more characters.]` : text;
  }
  return fileContents(await api.send(t.method, path, { ...opts, accept: "*/*" }), path);
}

/** A file as MCP content: an image as an image, plain text as text, anything else as an
 *  embedded binary resource, and one over 5 MB as its description only. */
async function fileContents(res: Response, path: string): Promise<Contents> {
  const type = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const name = filename ? safeDecode(filename) : path.split("/").pop() ?? "file";
  const describe = (size: number) =>
    new Contents([
      { type: "text", text: JSON.stringify({ filename: name, content_type: type, size, returned: false, reason: "larger than the 5 MB a tool call returns" }, null, 2) },
    ]);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FILE_LIMIT) {
    await res.body?.cancel().catch(() => undefined);
    return describe(declared);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > FILE_LIMIT) return describe(bytes.byteLength);
  const label: ToolContent = { type: "text", text: `${name} (${type}, ${bytes.byteLength} bytes)` };
  const uri = `mails:/${path}`;
  if (IMAGE_TYPES.has(type)) return new Contents([{ type: "image", data: base64(bytes), mimeType: type }, label]);
  if (TEXT_TYPES.has(type)) return new Contents([{ type: "resource", resource: { uri, mimeType: type, text: new TextDecoder().decode(bytes) } }, label]);
  return new Contents([{ type: "resource", resource: { uri, mimeType: type, blob: base64(bytes) } }, label]);
}

function makeApi(ctx: ToolContext) {
  const base = (ctx.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  type Opts = { query?: Args; body?: unknown; idempotencyKey?: string; noAuth?: boolean; accept?: string; waitSeconds?: number };

  async function send(method: string, path: string, opts: Opts = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? "application/json", "User-Agent": `mails-mcp/${MCP_SERVER_VERSION}` };
    if (!opts.noAuth) headers.Authorization = `Bearer ${ctx.apiKey}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    // A long poll (GeneratedTool.longPoll) holds the call open for up to `waitSeconds`: it gets
    // that long and 15 seconds more, and is sent once, since a resend would start the wait over.
    const once = opts.waitSeconds !== undefined;
    const limitMs = once ? (opts.waitSeconds! + 15) * 1000 : 30_000;
    // A retry is safe when the request cannot have acted twice: a read, or a write whose
    // Idempotency-Key makes a resend replay the first answer. A rate limit is waited out only
    // when it clears within seconds; a longer one comes back with its reset time, because a
    // tool call that sleeps for minutes looks hung.
    const retrySafe = method === "GET" || Boolean(opts.idempotencyKey);
    const url = `${base}${path}${queryString(opts.query)}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: payload, signal: timeoutSignal(ctx.signal, limitMs) });
      } catch (err) {
        if (ctx.signal?.aborted) throw new ApiCallError("The call was cancelled.");
        if (retrySafe && !once && attempt < 2) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ApiCallError(`${method} ${path} did not reach the API: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.ok) return res;
      if (once) throw await apiError(res, method, path);
      // Retry-After counts on a 5xx as on a 429: a send the email service is not taking comes
      // back 503 with Retry-After: 60 (lib/mail/rail-failure.ts), and resending it at once only
      // met the same refusal. A wait of up to 5 seconds is waited out; a longer one is the error.
      const header = res.headers.get("retry-after");
      const retryAfter = header === null || header.trim() === "" ? NaN : Number(header);
      const told = Number.isFinite(retryAfter) && retryAfter >= 0;
      const waitable =
        res.status === 429 ? told && retryAfter > 0 && retryAfter <= 5 : res.status >= 500 && retrySafe && (!told || retryAfter <= 5);
      if (attempt < 2 && waitable) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(told ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw await apiError(res, method, path);
    }
  }

  return {
    send,
    async json(method: string, path: string, opts: Opts = {}): Promise<unknown> {
      const res = await send(method, path, opts);
      if (res.status === 204) return {};
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    },
  };
}

/** The API's own error message. A plan refusal is named in words, and the envelope's
 *  `upgrade_url` stays out of tool output. A rate limit says when it resets, as a time and in
 *  seconds (the body's `resets_at` and `retry_after_seconds`), or that waiting will not lift it
 *  (`resets_at` null), so an agent knows whether and when to come back. */
async function apiError(res: Response, method: string, path: string): Promise<ApiCallError> {
  let error: { message?: string; resets_at?: string | null; retry_after_seconds?: number | null } | undefined;
  try {
    error = ((await res.json()) as { error?: typeof error })?.error;
  } catch {
    /* not JSON */
  }
  let message = error?.message || `${method} ${path} failed with ${res.status}`;
  if (res.status === 429) {
    const header = Number(res.headers.get("retry-after"));
    const seconds = header > 0 ? header : typeof error?.retry_after_seconds === "number" ? error.retry_after_seconds : undefined;
    if (error && error.resets_at === null) message += " Waiting will not lift this limit.";
    else if (error?.resets_at) message += ` It resets at ${error.resets_at}${seconds ? `, in ${seconds} seconds` : ""}.`;
    else if (seconds) message += ` It resets in ${seconds} seconds.`;
  }
  return new ApiCallError(message, res.status);
}

const INBOUND_EVENT_TYPES = new Set(["reply.received", "message.received", "message.received.unauthenticated"]);

/**
 * What a tool hands a model. Never the sender's HTML: received mail (an `rcv_` id, an inbound
 * thread message, an inbound event and everything inside it) loses `body_html` and
 * `extracted_html`, as mails_get_received always did. And no plan or checkout links: any
 * `upgrade_url` is dropped, since the MCP directories refuse tool output that sells a plan.
 */
export function sanitize(value: unknown, inbound = false): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, inbound));
  if (!value || typeof value !== "object") return value;
  const o = value as Args;
  const isInbound =
    inbound ||
    (typeof o.id === "string" && o.id.startsWith("rcv_")) ||
    o.direction === "inbound" ||
    INBOUND_EVENT_TYPES.has(String(o.type ?? "")) ||
    INBOUND_EVENT_TYPES.has(String(o.event_type ?? ""));
  const out: Args = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "upgrade_url") continue;
    if (isInbound && (k === "body_html" || k === "extracted_html")) continue;
    out[k] = sanitize(v, isInbound);
  }
  return out;
}

/** `since` in the form every `created_at` has (the toISOString form), or a plain date. The
 *  events route reads any ISO 8601 time; a value it cannot read is passed on for it to refuse. */
export function normalizeSince(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

function pick(a: Args, keys: string[]): Args {
  const out: Args = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

/** One path segment from an argument, which must be there. */
function segment(v: unknown, name: string): string {
  if (v === undefined || v === null || v === "") throw new ApiCallError(`${name} is required.`);
  return encodeURIComponent(String(v));
}

function keyFor(a: Args): string {
  return typeof a.idempotency_key === "string" && a.idempotency_key ? a.idempotency_key : newKey();
}

function newKey(): string {
  return `mcp-${globalThis.crypto.randomUUID()}`;
}

function queryString(query?: Args): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function timeoutSignal(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`no answer within ${ms / 1000} seconds`)), ms);
  (timer as { unref?: () => void }).unref?.();
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener("abort", () => ctl.abort(outer.reason), { once: true });
  }
  return ctl.signal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
