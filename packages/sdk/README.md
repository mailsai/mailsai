# @mailsai/sdk

Email API for AI agents — TypeScript / JavaScript SDK.

Per-agent email addresses on your domain, per-agent reputation, and prompt-injection scanning on every inbound. Your agent reads the reply and decides what to say — intent + entity extraction is opt-in.

```bash
npm install @mailsai/sdk
```

The package is **ESM-only** — use `import`, not `require()`. In a plain `npm init -y`
project, add `"type": "module"` to your package.json first.

## Quick start

Create the agent once (this mints its inbox address), then send from it. Skipping the
create step is the most common first-run error — `mails.agent("sarah")` only references
an agent, it does not create one, so sending returns `404 agent_not_found`.

```ts
import { mails, createClient } from "@mailsai/sdk";

// One-time setup: create the agent. It gets sarah@<your-workspace>.mails.ai
const client = createClient(); // reads MAILS_API_KEY from env
await client.agents.create("sarah");

// Reads MAILS_API_KEY from env (or pass via mails.agent(name, { apiKey: "mk_live_..." }))
const sarah = mails.agent("sarah");

// Send transactional mail — something the recipient asked for. mails.ai firewalls
// cold outreach: a "just reaching out / looking forward to talking" body is rejected
// with 422 cold_email_prohibited, by design.
await sarah.send({
  to: "user@example.com",
  subject: "Your password reset code",
  body: "Your verification code is 481920. It expires in 10 minutes.",
});

sarah.onReply((reply) => {
  // Always present — the delivery + security + identity layer:
  // reply.injection_score   → 0.02  (six-category prompt-injection scan)
  // reply.sender_reputation → 0.91  (per-agent reputation)
  //
  // Present only when classification is enabled (opt-in, +$0.003/inbound):
  // reply.intent            → "schedule_demo" | "ask_question" | "decline" | …
  // reply.entities          → { date: "2026-05-16", time: "10:00", … }
  // reply.urgency           → 0.8
  //
  // Your agent reads the reply and decides what to send next.
  console.log(reply.injection_score, reply.sender_reputation);
});
```

## Lower-level client

For full access to all resources (threads, drafts, events, agents, suppression, webhooks, reputation, billing, logs):

```ts
import { createClient } from "@mailsai/sdk";

const client = createClient({ apiKey: process.env.MAILS_API_KEY! });

// Send via any agent
await client.send("sarah", { to: "lead@example.com", subject: "Demo", body: "…" });

// Or call resources directly
const threads = await client.threads.list({ agent_id: "agent_abc123" });
const usage = await client.billing.usage();
const reputation = await client.reputation.get("agent_abc123");

// SSE stream of inbound events
const ctrl = client.events.stream({
  event_types: ["reply.received", "message.delivered"],
  onEvent: (e) => console.log(e.type, e),
  onError: (err) => console.error(err),
});
// …later
ctrl.abort();
```

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

## Idempotency

```ts
await sarah.send({
  to: "lead@example.com",
  subject: "Demo",
  body: "…",
  idempotency_key: "weekly-followup-2026-05-14-lead-123",
});
```

Replays within 24 hours return the original response with `Idempotent-Replay: true` header.

## Errors

All API errors throw `MailsError`:

```ts
import { MailsError } from "@mailsai/sdk";

try {
  await sarah.send({ to: "blocked@example.com", subject: "…", body: "…" });
} catch (err) {
  if (err instanceof MailsError) {
    console.error(err.type, err.code, err.message, err.status, err.requestId);
  }
}
```

## Documentation

- Full docs: [mails.ai/docs](https://mails.ai/docs)
- API reference: [mails.ai/docs/api](https://mails.ai/docs)
- Source: [github.com/mailsai/mailsai](https://github.com/mailsai/mailsai/tree/main/packages/sdk)

## License

MIT
