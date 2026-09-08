# Examples

Each one runs on a **test key** (`mk_test_…`), which exercises the entire real request path —
validation, the outbound firewall, threading, events, webhooks — and delivers nothing. Get one
at [mails.ai](https://mails.ai) → API Keys → New key → mode: test. No card, no domain, no DNS.

```bash
export MAILS_API_KEY=mk_test_xxx
```

| | What it shows | Run |
|---|---|---|
| [01-send](01-send) | First email out, and the firewall refusing a cold one | `npm i @mailsai/sdk && node 01-send/index.mjs` |
| [02-inbox-loop](02-inbox-loop) | The agent has an inbox; replies arrive as structured events, threading back in | `node 02-inbox-loop/index.mjs` |
| [03-injection-firewall](03-injection-firewall) | A real prompt-injection payload, scored and quarantined before your model sees it | `node 03-injection-firewall/index.mjs` |
| [04-openai-agents-sdk](04-openai-agents-sdk) | Two function tools give an OpenAI Agents SDK agent its own mailbox | `pip install mailsai openai-agents && python 04-openai-agents-sdk/agent.py` |
| [05-langgraph](05-langgraph) | A conditional edge that branches on `injection_score` | `pip install mailsai langgraph && python 05-langgraph/graph.py` |
| [06-mcp-clients](06-mcp-clients) | Claude Desktop / Claude Code / Cursor / Cline / Continue / Windsurf config | see the README |

## The two things worth taking away

**Inbound is data, not a MIME blob.** Every received message arrives as a typed event with
`injection_score` and `sender_reputation` on it, plus `intent`, `entities` and `urgency` when
you enable classification. You branch on numbers instead of writing your own parser and your
own detector.

**Sending is bounded by the API, not by your prompt.** Cold outreach is refused inside the send
call with `422 cold_email_prohibited`. That is not a setting you can forget to switch on, and it
holds when the instruction to send it arrived inside an email your agent was reading.

## Going live

Swap `mk_test_` for `mk_live_`. Free covers 3,000 sends and 3,000 inbound a month with no card.
Sending on a live key is enabled after a short review — a deliberate cost of running a clean
sending estate rather than reselling someone else's.
