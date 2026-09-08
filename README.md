<h1 align="center">mails.ai</h1>

<p align="center">
  <strong>Email for AI agents — an inbox your agent owns, with a firewall in front of it.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mailsai/mcp-server"><img alt="npm @mailsai/mcp-server" src="https://img.shields.io/npm/v/@mailsai/mcp-server?label=%40mailsai%2Fmcp-server"></a>
  <a href="https://www.npmjs.com/package/@mailsai/sdk"><img alt="npm @mailsai/sdk" src="https://img.shields.io/npm/v/@mailsai/sdk?label=%40mailsai%2Fsdk"></a>
  <a href="https://pypi.org/project/mailsai/"><img alt="PyPI mailsai" src="https://img.shields.io/pypi/v/mailsai?label=mailsai"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="https://mails.ai">mails.ai</a> ·
  <a href="https://api.mails.ai/reference">API reference</a> ·
  <a href="examples">examples</a>
</p>

---

This repo holds the client side of mails.ai: the **MCP server**, the **TypeScript** and
**Python** SDKs, and **runnable examples**. All MIT. The API itself is hosted — you don't
run a mail server.

**Want to see an agent actually do a job first?**

```bash
cd templates/support-agent && npm install
MAILS_API_KEY=mk_test_xxx npm start
```

It answers a billing question in-thread, escalates one it shouldn't guess at, and refuses a
real prompt-injection attack — in about a minute, on a test key that transmits nothing.

Or start from the primitive:

```bash
npm install @mailsai/sdk        # or: pip install mailsai
```

```ts
import { createClient } from "@mailsai/sdk";

const mails = createClient(); // MAILS_API_KEY

await mails.send({
  from: "billing",                       // the agent is created on first use
  to: "customer@example.com",
  subject: "Your invoice #221 is ready",
  body: "Invoice #221 for March is attached, due the 30th.",
});
```

No agent to pre-create, no domain to verify, no DNS. A **test key** (`mk_test_…`) runs that
entire path — validation, firewall, threading, events, webhooks — and delivers nothing, so you
can integrate before you decide anything.

## Why this exists

Most "email for agents" is a send API with agent-flavoured docs. The two things a raw API
(SES, Resend, Mailgun) genuinely doesn't give an autonomous agent are the two that bite:

### 1. Your agent has an inbox, and inbound arrives as data

Agents don't just send. They receive, thread, and act on what comes back. Every agent gets a
real receiving address the moment it exists, and every inbound message arrives as a typed
event — not a MIME blob you write a parser for:

```jsonc
{
  "type": "reply.received",
  "injection_score": 0.99,                  // the evidence — always present
  "quarantined": true,                      // OUR VERDICT — always present on inbound
  "sender_reputation": 0.30,                // always present
  "intent": "ask_question",                 // when classification is enabled
  "entities": { "invoice": "221" },
  "data": {
    "from": { "address": "attacker@example.net" },
    "injection_categories": ["instruction_override", "data_exfil"],
    "quarantined": true
  }
}
```

### 2. An agent reading email is an attack surface, and one that sends can torch you

A prompt-injection payload hidden in an inbound message is the top security risk for any agent
that acts on what it reads. Every inbound is scanned across six categories and quarantined
before your model sees it, so your branch is `if (event.quarantined) return;` — our verdict,
not a threshold you have to pick and re-tune yourself — instead of hoping your model notices
it is being attacked inside the same prompt as the attack. (`injection_score` is still there
when you want the raw number.)

And in the other direction: **cold outreach is refused inside the send call** with
`422 cold_email_prohibited`. Not a setting, not a clause in an acceptable-use policy — a
refusal, with a reason your agent can read, a sandbox to test against and a second review if
you think it was wrong. An agent that crosses a 0.3% complaint rate auto-suspends, before the
upstream provider's 0.5% line ever sees it. Your reputation cannot be spent by a prompt you
did not write.

That refusal is the product, not a limitation of it: it is why a shared sending estate stays
clean enough to be worth being on.

## What's here

| | |
|---|---|
| **[packages/mcp-server](packages/mcp-server)** | `@mailsai/mcp-server` — 20 MCP tools. Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, any MCP runtime. |
| **[packages/sdk](packages/sdk)** | `@mailsai/sdk` — TypeScript / JavaScript, ESM. |
| **[packages/sdk-py](packages/sdk-py)** | `mailsai` — Python 3.10+. |
| **[templates/support-agent](templates/support-agent)** | **Start here.** A working support agent — reads inbound mail, answers from your data, replies in-thread, escalates refunds, refuses prompt injection. One test key, no LLM key, no DNS. |
| **[examples](examples)** | Six runnable examples: send, inbox loop, the injection firewall, OpenAI Agents SDK, LangGraph, MCP client config. |

## MCP in one block

```json
{
  "mcpServers": {
    "mails": {
      "command": "npx",
      "args": ["-y", "-p", "@mailsai/mcp-server", "mails-mcp"],
      "env": { "MAILS_API_KEY": "mk_test_xxx" }
    }
  }
}
```

Or watch the whole loop first, with nothing configured:

```bash
MAILS_API_KEY=mk_test_xxx npx -y -p @mailsai/mcp-server mails-mcp-demo
```

## Pricing, briefly

Free is 3,000 sends and 3,000 inbound a month, one agent, no card. Paid tiers add agents,
custom domains and dedicated IPs. [Full pricing](https://mails.ai/pricing).

## Contributing

Issues and PRs welcome on the SDKs, the MCP server and the examples — especially examples for a
framework that isn't covered yet. The API implementation lives in a private repo; anything
server-side is best filed as an issue here.

## License

MIT. See [LICENSE](LICENSE).
