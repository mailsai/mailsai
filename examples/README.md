# Examples

Each one runs on a **test key** (`mk_test_…`), which exercises the entire real request path —
validation, the outbound firewall, threading, events, webhooks — and delivers nothing. Get one
at [mails.ai](https://mails.ai) → API Keys → New key → mode: test. No card, no domain, no DNS.

```bash
export MAILS_API_KEY=mk_test_xxx
```

| | What it shows | Run |
|---|---|---|
| [01-send](01-send) | First email out, and how a test key flags a message a live key would not send | `npm i @mailsai/sdk && node 01-send/index.mjs` |
| [02-inbox-loop](02-inbox-loop) | The agent has an inbox; replies arrive as structured events, threading back in | `node 02-inbox-loop/index.mjs` |
| [03-injection-firewall](03-injection-firewall) | A real prompt-injection payload, scored and quarantined before your model sees it | `node 03-injection-firewall/index.mjs` |
| [04-openai-agents-sdk](04-openai-agents-sdk) | Two function tools give an OpenAI Agents SDK agent its own mailbox | `pip install mailsai openai-agents && python 04-openai-agents-sdk/agent.py` |
| [05-langgraph](05-langgraph) | A conditional edge that branches on `injection_score` | `pip install mailsai langgraph && python 05-langgraph/graph.py` |
| [06-mcp-clients](06-mcp-clients) | Claude Desktop / Claude Code / Cursor / Cline / Continue / Windsurf config | see the README |
| [07-forwarded-email-assistant](07-forwarded-email-assistant) | Forward it a bill with "cancel this" on top: it drafts the request, asks before sending, follows up and passes the answer back | `OWNER_EMAIL=you@example.com node 07-forwarded-email-assistant/index.mjs` |

## The two things worth taking away

**Inbound is data, not a MIME blob.** Every received message arrives as a typed event with
`injection_score` and `sender_reputation` on it, plus `intent`, `entities` and `urgency` when
you enable classification. You branch on numbers instead of writing your own parser and your
own detector.

**The loop keeps its state in mails.ai.** A draft waits until a person approves it, tags tie a
conversation's messages together, and a scheduled follow-up can be canceled when the answer
lands. An agent that restarts reads all of it back, so 07 keeps nothing locally except its
place in the event stream.

## Going live

Swap `mk_test_` for `mk_live_`. Free covers 3,000 sends and 3,000 inbound a month with no card.
Sending on a live key is enabled after a short review — a deliberate cost of running a clean
sending estate rather than reselling someone else's.
