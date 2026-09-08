# A support agent that does the job

Not a snippet. A working agent that reads inbound email, answers billing questions from your
own data, replies **in the same thread**, escalates what it shouldn't guess at, and refuses to
be talked into anything.

```bash
npm install
MAILS_API_KEY=mk_test_xxx npm start
```

That's the whole setup. **One key, nothing else** — no LLM key, no domain, no DNS, no mailbox.
A test key runs the entire real path (agent provisioning, the outbound firewall, threading, the
injection scanner, events) and transmits nothing, so you can watch it work before you trust it
with real mail. Get one at [mails.ai](https://mails.ai) → API Keys → New key → mode: test.

## What you see

```
1. Giving the agent an inbox
   sends as    support@your-workspace.mails.ai
   receives at support.your-workspace@in.mails.ai

2. Three emails arrive — one answerable, one it should not guess at, one attack

   from dana@acme.com   subject Question about invoice #4821
   injection_score 0.02
   intent invoice_status
   ✓ replied in thread msg_01KZ…

   from sam@example.net   subject invoice
   injection_score 0.02
   intent unknown_account   → escalated to a human
   ✓ replied in thread msg_01KZ…

   from attacker@example.net   subject Re: Question about invoice #4821
   injection_score 0.99  instruction_override, role_hijack, data_exfil, tool_invocation
   ✗ refused to act — this message is trying to redirect the agent. Logged, not answered.

3. What the agent did, unattended
   1 answered · 1 escalated to a human · 1 attack refused
```

That third email is the one worth staring at. It's a real prompt-injection payload arriving
the way it actually arrives — as a reply in a legitimate thread. The agent branches on
`injection_score`, a number it was handed, **before** any of that text reaches a model. You are
not asking an LLM to notice it's being attacked inside the same prompt as the attack.

## The three decisions worth copying

**Escalation is a feature.** Refund and dispute mail is deliberately *not* auto-answered. An
agent that improvises about money loses the customer twice. `replyFor()` returns
`escalate: true` and the reply says a human will follow up — which is both honest and the
correct product behaviour.

**Replies go in-thread.** `messages.reply(sourceId, …)` reuses the Message-ID chain, so the
answer lands in the existing conversation in the recipient's client instead of starting a new
one. Threading is the difference between an agent and a mail-merge.

**The reply text is plain code, on purpose.** No LLM key is required to see this work. Swap
`replyFor()` for your model of choice — the safety gate, the escalation rule and the threading
around it don't change. A template that demands a second API key before it shows you anything
is a template nobody runs.

## Going live

```bash
MAILS_LIVE=true MAILS_API_KEY=mk_live_xxx npm start
```

Now it watches the real receive address printed in step 1 and answers real people. Send it an
email mentioning invoice `4821` and watch the reply arrive in your own thread. Read
`agent.mjs` first — with a live key, it sends.

Cold outreach still can't leave, whatever it's asked to do: the API refuses it with
`422 cold_email_prohibited`. That holds even when the instruction arrives inside an email the
agent is reading, which is the case that matters.

## Files

| | |
|---|---|
| `agent.mjs` | The whole agent, readable in one sitting |
| `invoices.json` | Sample data it answers from — point this at your own |
| `.env.example` | The one variable that matters |

Free covers 3,000 sends and 3,000 inbound a month with no card.
