# @mailsai/sdk

Email API for AI agents — TypeScript / JavaScript SDK.

Per-agent email addresses on your domain, per-agent reputation, and prompt-injection scanning on inbound mail. Your agent reads the reply and decides what to say — intent + entity extraction is opt-in.

```bash
npm install @mailsai/sdk
```

The package is **ESM-only** — use `import`, not `require()`. In a plain `npm init -y`
project, add `"type": "module"` to your package.json first.

## Quick start

Create the agent once (this gives it an inbox), then send from it. Skipping the
create step is the most common first-run error — `mails.agent("sarah")` only references
an agent, it does not create one, so sending returns `404 agent_not_found`.

```ts
import { mails, createClient } from "@mailsai/sdk";

// One-time setup: create the agent. It receives mail at sarah.<your-workspace>@in.mails.ai
const client = createClient(); // reads MAILS_API_KEY from env
await client.agents.create("sarah");

// Reads MAILS_API_KEY from env (or pass via mails.agent(name, { apiKey: "mk_live_..." }))
const sarah = mails.agent("sarah");

// Send transactional mail: something the recipient asked for.
await sarah.send({
  to: "user@example.com",
  subject: "Your password reset code",
  body: "Your verification code is 481920. It expires in 10 minutes.",
});

sarah.onReply((reply) => {
  // A reply is scanned for prompt injection:
  // reply.injection_score   → 0.02  (0 to 1; at 0.95 or more it is marked quarantined)
  // reply.quarantined       → false
  //
  // A reply is not read for intent: that is for new mail (`onMessage`) to an agent with
  // `classify_inbound` on (Pro and Scale include it at no extra charge). So on every reply:
  // reply.intent            → "general_reply"
  // reply.sender_reputation → 0.85  (0.3 when the reply scores as an injection attempt,
  //                                  0.5 when it could not be scanned)
  //
  // Your agent reads the reply and decides what to send next.
  console.log(reply.injection_score, reply.quarantined);
});
```

## Lower-level client

For full access to every resource (messages, received mail and attachments, threads, labels, drafts, search, metrics, events, agents, webhooks, domains, API keys, suppression, reputation, billing, logs):

```ts
import { createClient } from "@mailsai/sdk";

const client = createClient({ apiKey: process.env.MAILS_API_KEY! });

// Send via any agent
await client.send("sarah", { to: "user@example.com", subject: "Your receipt", body: "…" });

// Or call resources directly
const threads = await client.threads.list({ agent_id: "sarah" }); // an agent's name or id (agt_…)
const usage = await client.billing.usage();
const reputation = await client.reputation.get("sarah");

// SSE stream of inbound events
const ctrl = client.events.stream({
  event_types: ["reply.received", "message.delivered"],
  onEvent: (e) => console.log(e.type, e),
  onError: (err) => console.error(err),
});
// …later
ctrl.abort();
```

Search, labels and attachments:

```ts
import { writeFile } from "node:fs/promises";

const hits = await client.search({ q: "invoice", type: "received", has_attachment: true, after: new Date("2026-10-01") });

const vip = await client.labels.create({ name: "VIP", color: "red" });
await client.threads.update(hits.data[0].thread_id!, { label_ids: [vip.id] });

const files = await client.received.attachments.list(hits.data[0].id);
const bytes = await client.received.attachments.download(hits.data[0].id, files.data[0].id); // Uint8Array
await writeFile(files.data[0].filename, bytes);
```

`events.list({ since })` (and `agent.listReplies({ since })`) takes a `Date` or an ISO 8601 string
and sends it in the form every `created_at` has (`2026-10-04T09:30:00.000Z`). A plain date such
as `2026-10-04` is sent as it is. A value that is not a time throws a `MailsError`
(`param: "since"`) before any request is made, as the API would answer it 400. The stream's `since` is different: it is a position
the stream gave, or an event id (`evt_…`), to resume from.

A stream reconnects by itself, from where the server said it was, and does not hand `onEvent` the
same event twice while it runs. Events arrive in id order, except one that was written late: it
arrives after newer ones instead of being skipped. To carry on after a restart, save the position
`onPosition` gives you and pass it as `since`: an event id starts after that event, and a position
starts exactly where the stream was. Across a restart delivery is at least once, so keep the event
ids you handled if handling one twice would matter.

Every event type is listed on `TypedEvent.type`. An inbound event's `data` says how the sender was
authenticated, checked from the email itself and never from a header in it (`InboundAuthentication`):
`dkim`, `dkim_domain`, `dmarc`, `spf` and `auth_failed`, which is true only on
`message.received.unauthenticated`, the forged-sender event. It also says who the email is from
(`InboundSender`). `from` is `{ address, name }`, the first mailbox of the From header: the address
those checks are about, and the one a reply goes to when there is no Reply-To. `envelope_from` is
the envelope sender, where bounces go, often a sending service's own address. `arc` is the email's
ARC chain as we checked it, and `trusted_forwarder` names the mail service whose ARC seal vouched
for the original sender of forwarded mail, or null.

`agent.onMessage`, `agent.onReply`, `listMessages()` and `listReplies()` give an `InboundEvent`,
whose `data` always carries `from`, `subject`, `extracted_text`, `injection_categories` and
`auth_failed`, so `event.data.from.address` needs no check or cast. `isInboundEvent(event)` narrows
any other event to one, such as a verified webhook's.

## Every method

All of these are on a client from `createClient()`, and each returns a Promise of the API's JSON
unless the table says otherwise.

**Messages you send**

| Method | API call |
|---|---|
| `messages.send(input)`, also `send(input)` or `send(agent, input)` | `POST /v1/messages` |
| `messages.batch(messages, { idempotency_key? })` | `POST /v1/messages/batch` |
| `messages.list({ limit, cursor, agent_id, thread_id, q })` | `GET /v1/messages` |
| `messages.get(id)` | `GET /v1/messages/{id}` |
| `messages.reply(id, { body, …, idempotency_key? })` | `POST /v1/messages/{id}/reply` |
| `messages.forward(id, { to, …, idempotency_key? })` | `POST /v1/messages/{id}/forward` |
| `messages.reschedule(id, scheduled_at)` | `PATCH /v1/messages/{id}` |
| `messages.cancel(id)` | `POST /v1/messages/{id}/cancel` |
| `messages.raw(id)`, the message as an RFC 822 string | `GET /v1/messages/{id}/raw` |
| `messages.appeal({ agent?, subject, body })` | `POST /v1/messages/appeal` |

**Mail you receive**

| Method | API call |
|---|---|
| `received.list({ limit, cursor, agent_id, thread_id, q, from, since })` | `GET /v1/messages/received` |
| `received.wait({ agent_id, from, to, since, has, timeout })`, the newest match as soon as it arrives | `GET /v1/messages/received/wait` |
| `received.get(id)` | `GET /v1/messages/received/{id}` |
| `received.attachments.list(id)` | `GET /v1/messages/received/{id}/attachments` |
| `received.attachments.download(id, attachmentId, { inline? })`, the bytes as a `Uint8Array` | `GET /v1/messages/received/{id}/attachments/{attachment_id}` |
| `test.inbound({ agent, from, body_text, … })`, test keys only | `POST /v1/test/inbound` |

**Threads, labels and search**

| Method | API call |
|---|---|
| `threads.list({ limit, cursor, agent_id, status, folder, read, label, q })` | `GET /v1/threads` |
| `threads.get(id)`, with its messages | `GET /v1/threads/{id}` |
| `threads.update(id, { labels, label_ids, status, read, folder })` | `PATCH /v1/threads/{id}` |
| `threads.remove(id, { permanent? })`, to trash or for good | `DELETE /v1/threads/{id}` |
| `labels.list()` | `GET /v1/labels` |
| `labels.create({ name, color? })` | `POST /v1/labels` |
| `labels.get(id)` | `GET /v1/labels/{id}` |
| `labels.update(id, { name?, color? })` | `PATCH /v1/labels/{id}` |
| `labels.remove(id)` | `DELETE /v1/labels/{id}` |
| `search({ q, agent_id, from, to, after, before, has_attachment, folder, label, type, limit, cursor })` | `GET /v1/search` |

To restore a trashed thread, move it back: `threads.update(id, { folder: "inbox" })`.

**Drafts**

| Method | API call |
|---|---|
| `drafts.create(input)` | `POST /v1/drafts` |
| `drafts.list({ limit, cursor, agent_id, status })` | `GET /v1/drafts` |
| `drafts.get(id)` | `GET /v1/drafts/{id}` |
| `drafts.update(id, patch)` | `PATCH /v1/drafts/{id}` |
| `drafts.remove(id)` | `DELETE /v1/drafts/{id}` |
| `drafts.send(id, { send_at?, idempotency_key? })` | `POST /v1/drafts/{id}/send` |

**Agents**

| Method | API call |
|---|---|
| `agents.create(name, opts?)`, also `createAgent(name, opts?)` | `POST /v1/agents` |
| `agents.create({ address, forwarding, ...opts })`, an agent at an address on your own verified domain | `POST /v1/agents` |
| `agents.list({ limit, cursor, status })`, also `listAgents(opts?)` | `GET /v1/agents` |
| `agents.get(id)` | `GET /v1/agents/{id}` |
| `agents.update(id, patch)` | `PATCH /v1/agents/{id}` |
| `agents.archive(id)` | `DELETE /v1/agents/{id}` |
| `agents.inbox(id)`, unread and thread counts per folder and label | `GET /v1/agents/{id}/inbox` |
| `agents.verifyForwarding(id)`, one test email through a forwarding-mode agent's forward | `POST /v1/agents/{id}/forwarding/verify` |

**Events and webhooks**

| Method | API call |
|---|---|
| `events.list({ limit, cursor, event_type, agent_id, since })` | `GET /v1/events` |
| `events.get(id)` | `GET /v1/events/{id}` |
| `events.redeliver(id)` | `POST /v1/events/{id}/redeliver` |
| `events.stream({ event_types, since, onEvent, onError, onPosition })`, also `stream(opts)`; returns an `AbortController` | `GET /v1/events/stream` |
| `webhooks.create({ url, event_types, description })` | `POST /v1/webhooks` |
| `webhooks.list({ limit, cursor })` | `GET /v1/webhooks` |
| `webhooks.get(id)` | `GET /v1/webhooks/{id}` |
| `webhooks.update(id, { url, event_types, description, active })` | `PATCH /v1/webhooks/{id}` |
| `webhooks.remove(id)` | `DELETE /v1/webhooks/{id}` |
| `webhooks.rotateSecret(id)` | `POST /v1/webhooks/{id}/rotate-secret` |
| `webhooks.deliveries(id, { limit, cursor })` | `GET /v1/webhooks/{id}/deliveries` |
| `webhooks.test(id)` | `POST /v1/webhooks/{id}/test` |
| `webhooks.replayDelivery(deliveryId)` | `POST /v1/webhook-deliveries/{id}/replay` |
| `webhooks.verify(body, signature, secret)`, also `mails.webhooks.verify`; no request | none |

**Domains, keys and suppression**

| Method | API call |
|---|---|
| `domains.create(domain)` | `POST /v1/domains` |
| `domains.list()` | `GET /v1/domains` |
| `domains.get(id)` | `GET /v1/domains/{id}` |
| `domains.verify(id)` | `POST /v1/domains/{id}/verify` |
| `domains.remove(id)` | `DELETE /v1/domains/{id}` |
| `api_keys.create({ name, agent_id, scopes, mode, expires_at })` | `POST /v1/api-keys` |
| `api_keys.list({ limit, cursor })` | `GET /v1/api-keys` |
| `api_keys.revoke(id)` | `DELETE /v1/api-keys/{id}` |
| `connected_apps.list({ limit, cursor })` | `GET /v1/oauth/grants` |
| `connected_apps.revoke(id)` | `DELETE /v1/oauth/grants/{id}` |
| `suppression.check(address)` | `GET /v1/suppression?address=…` |
| `suppression.list({ limit, cursor, view? })`, `view: "suppressed"` for suppressed recipients | `GET /v1/suppression` |
| `suppression.allow(address, attestation)` | `POST /v1/suppression/allow` |
| `suppression.revoke(id)` | `DELETE /v1/suppression/allow/{id}` |

**Account**

| Method | API call |
|---|---|
| `me()` | `GET /v1/me` |
| `metrics.get({ from, to, agent_id, interval })` | `GET /v1/metrics` |
| `reputation.get(agentId?)` | `GET /v1/reputation` |
| `billing.usage()` | `GET /v1/billing/usage` |
| `billing.portal(returnUrl?, { price_lookup_key? })` | `POST /v1/billing/portal` |
| `logs.list({ limit, cursor, category, action })` | `GET /v1/logs` |
| `health()` | `GET /api/health` |

**The agent helper** (`mails.agent(name)` or `client.agent(name)`): `send(input)`,
`listReplies({ limit, since })`, `listMessages({ limit, since })`, `reputation()`,
`onReply(callback)` and `onMessage(callback)`. `name` is the agent's name or its id (`agt_…`).
When two agents share a name (one at `<workspace>.mails.ai` and one on your own domain), a key
tied to one of them means that one. A workspace key sends from the older one, and its reads
and listeners are refused with 409 `agent_name_conflict`: pass the id instead. A listener
hands that error, and a name no agent has, to its `onError`; with no `onError` it is written
to `console.error` once.

**A key tied to one agent** (`api_keys.create({ agent_id })`) reads and sends as that agent
only. Calls that read across the whole workspace (`billing.usage()`, `logs.list()`,
`connected_apps.list()`) or change it (webhooks, labels, domains, connected apps, revoking
keys, creating agents, send-anyway entries) throw `MailsError` with status 403 and code
`insufficient_scope`. `metrics.get()` counts only that agent's mail, and naming another agent
in `agent_id` throws the same error. `agents.list()` returns that agent only, `api_keys.list()`
only the keys tied to it, and `agents.get()` of any other agent throws `MailsError` with status
404 and code `agent_not_found`, as if it did not exist.

## Webhook verification

```ts
import { mails } from "@mailsai/sdk";

// In your webhook handler:
const event = mails.webhooks.verify(
  rawBody,
  req.headers["x-mails-signature"]!,
  process.env.MAILS_WEBHOOK_SECRET!
);
if (!event) return new Response("invalid signature", { status: 400 });
// event is the verified inbound event payload
```

## Configuration

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `MAILS_API_KEY` | none — required |
| `baseUrl` | `MAILS_BASE_URL` | `https://api.mails.ai` |
| `fetch` | — | global `fetch` |
| `maxRetryWaitSeconds` | — | `60` (at most 60) |

## Rate limits and retries

A rate-limited call (429), and a 5xx on a read or on a write with an idempotency key, is retried
up to three times. The API sends `Retry-After` only when the limit lifts within 60 seconds, and
the client sleeps that long, up to `maxRetryWaitSeconds` (60 by default, and never more than 60).

When the limit lifts later (an hourly window that will not clear within the minute, a daily or
monthly cap), the error body says when: `resets_at` and `retry_after_seconds`. The client then
does not sleep. It throws a `RateLimitError` at once, with `resetsAt` (an ISO 8601 time) and
`retryAfterSeconds` set and both named in the message, so a long limit never looks like a hung
call. `resetsAt` is `null` when waiting never lifts the limit (a plan cap that only an upgrade
does). `RateLimitError` is a `MailsError`, so code that catches `MailsError` still catches it.

## Idempotency

```ts
await sarah.send({
  to: "user@example.com",
  subject: "Your receipt",
  body: "…",
  idempotency_key: "receipt-order-10473",
});
```

Replays within 24 hours return the original response with `Idempotent-Replay: true` header.
`messages.reply`, `messages.forward` and `drafts.send` take `idempotency_key` the same way, and
`messages.batch` takes it in its second argument (`{ idempotency_key }`).

## Sign-up codes and links

A received message carries `codes` and `links`, picked out of its text and HTML by fixed rules, with no AI involved. Each code is a `value`, the likeliest first. Each link is a `url` and a `kind` (`verify`, `sign_in`, `reset_password`, `unsubscribe` or `other`), the action links first.

`received.wait()` answers as soon as a matching message arrives, so an agent that has just asked a service for a code reads it in one call:

```ts
const askedAt = new Date().toISOString();
// …the agent signs up somewhere with its mails.ai address…
const { message } = await client.received.wait({ from: "github.com", has: "code", since: askedAt, timeout: 50 });
const code = message?.codes?.[0]?.value; // undefined: nothing arrived in 50 seconds
```

`from` is an address or a domain, and a domain includes its subdomains. `has` is `"code"`, or `"link"` for a `verify`, `sign_in` or `reset_password` link. `timeout` is 0 to 50 seconds (default 30), and without `since` it looks back 5 minutes. Mail judged forged and quarantined mail never match. Nothing in time is not an error: `message` is null and `timed_out` is true.

### One address per sign-up or test run

Mail to any plus address of an agent's `receiving_address` reaches the agent too, so each sign-up or test run can have an address of its own, and wait for that address's mail alone. `plusAddress()` builds one, and `to` takes only mail sent to it:

```ts
import { plusAddress } from "@mailsai/sdk";

const email = plusAddress(agent.receiving_address, `run-${Date.now()}`); // qa.acme+run-1792…@in.mails.ai
// …sign up with `email`…
const { message } = await client.received.wait({ to: email, has: "code", timeout: 50 });
```

Each received message says which address it came to in `delivered_to`, and `received.list({ to })` takes the same filter. A workspace may receive mail at 20 different plus addresses a day on Free, 1,000 on Pro and 10,000 on Scale. Past that, mail to a new one keeps only a record (`over_limit: "plus_address_limit"`) and raises `message.received.over_limit`, while the addresses already used that day keep working. A sign-in code or link from a service such as Google, Microsoft, Apple, a payment app or a bank never reaches a plus address either: such mail keeps only a record (`over_limit: "held_code"`), so sign up for those services at the agent's own address.

## Attachments

Up to 10 files and 25 MB in all. Give each file's bytes, or an https URL that mails.ai downloads when it sends, and give a file a `content_id` to show it inside the HTML instead of attaching it. Bytes travel inside the request, so together they can come to about 3 MB: give a larger file by its URL. A batch cannot carry attachments, so send a message with files on its own:

```ts
import { readFileSync } from "node:fs";

await sarah.send({
  to: "dana@example.com",
  subject: "Your invoice",
  body_html: '<img src="cid:logo" alt="Acme"><p>Your invoice is attached.</p>',
  attachments: [
    { filename: "logo.png", path: "https://files.example.com/logo.png", content_id: "logo" },
    { filename: "invoice-221.pdf", content_base64: readFileSync("invoice-221.pdf").toString("base64"), content_type: "application/pdf" },
  ],
});
```

A `path` must answer within 10 seconds, after at most 3 redirects, each to https, and never at a private, loopback or link-local address. A file that cannot be fetched refuses the whole send with a 400 `invalid_field` error whose `param` names it (`attachments.0.path`), and nothing is sent. `content_type` is optional with `path`: the type the URL answers with is used. A send with a future `scheduled_at` cannot carry attachments yet.

## One-click unsubscribe

Sends carry no unsubscribe headers unless you ask. For a newsletter or digest, opt in:

```ts
await sarah.send({
  to: "reader@example.com",
  subject: "This week's digest",
  body: "…",
  list_unsubscribe: true,
});
```

The message then carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and the recipient's mail app shows an Unsubscribe button. One click suppresses that address for your whole workspace, so later sends to it are refused with `recipient_suppressed`. Leave it off for password resets, sign-in links and receipts. It needs exactly one `to` recipient and no `cc` or `bcc`.

## Errors

All API errors throw `MailsError`; a 429 throws its subclass `RateLimitError`:

```ts
import { MailsError, RateLimitError } from "@mailsai/sdk";

try {
  await sarah.send({ to: "blocked@example.com", subject: "…", body: "…" });
} catch (err) {
  if (err instanceof RateLimitError) {
    console.error(err.resetsAt ? `rate limited until ${err.resetsAt}` : err.message);
  } else if (err instanceof MailsError) {
    console.error(err.type, err.code, err.message, err.status, err.requestId);
  }
}
```

A 402 (a plan limit, or a feature your plan does not include) also carries `upgradeUrl`, the
page where the plan can be changed, and its message ends with that link.

A send that succeeds answers `status` `sent`, `scheduled` (a future `scheduled_at`), or
`delivered` when delivery to every recipient was confirmed at once (with a live key, a send
only to the test address `reply@test.mails.ai` always is; a test key's sends answer `sent`). A
send that fails throws instead.

## Documentation

- Full docs: [mails.ai/docs](https://mails.ai/docs)
- API reference: [mails.ai/docs/api](https://mails.ai/docs)
- Source: [github.com/mailsai/mailsai](https://github.com/mailsai/mailsai/tree/main/packages/sdk)

## License

MIT
