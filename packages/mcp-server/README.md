# @mailsai/mcp-server

**Give your AI agent a real inbox it can't be phished through, and a sender it can't torch.**

An [MCP](https://modelcontextprotocol.io) server that drops email into any agent runtime — Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, or your own MCP client. Your agent can **send, receive, and thread** email, and every inbound runs through a **reputation + prompt-injection firewall** before it ever reaches your model.

Most "email for agents" is a send API. The two things a raw API (SES, Resend) *doesn't* give an autonomous agent are the two things that actually bite you:

- **A real inbox.** Agents don't just send — they receive, thread, and act on replies. You get structured inbound events (`intent`, `entities`, `injection_score`), not a raw MIME blob to parse yourself.
- **A firewall.** An agent reading email is an attack surface (prompt injection) and a liability (a looping agent can torch your sending reputation in minutes). Every inbound is injection-scanned; every send is reputation-checked, and an agent that crosses a **0.3% complaint rate auto-suspends** — before the upstream provider's 0.5% line ever sees it.

## Try it in 30 seconds (no signup, nothing really sends)

Run it with **no key at all** and it grades two emails — a normal one and a prompt-injection attack — through the real classifier a paying workspace hits:

```bash
npx -y -p @mailsai/mcp-server mails-mcp-demo
```

```
  1. A normal customer email
       injection_score    ····················  0.01
       verdict            ✓ clean — safe for your agent to act on
  2. A prompt-injection attack, same scanner
       injection_score    ████████████████████  0.99
       categories         instruction_override, data_exfil, tool_invocation
       quarantined        true — our verdict: do not act on this
```

Then add a free **test key** ([app.mails.ai/api-keys](https://app.mails.ai/api-keys) — self-serve, no approval queue) for the other half: an inbox your agent owns, threading, and reply. A `mk_test_…` key sends no real mail and is never billed:

```bash
MAILS_API_KEY=mk_test_xxx npx -y -p @mailsai/mcp-server mails-mcp-demo
```

```
  3. It sends email (like any email API)
       message            msg_...
  4. A reply arrives — and your agent gets STRUCTURED signal, not raw text
       intent             schedule_meeting
       injection_score    ····················  0.01
       verdict            ✓ clean — safe for your agent to act on
  5. A PHISHING email tries to hijack your agent — the firewall catches it FIRST
       injection_score    ███████████·········  0.55
       categories         instruction_override, data_exfil
       → your agent       sees injection_score + refuses to act — the attack never reaches your model unlabeled
```

## Install (any MCP client)

Add to your MCP config (e.g. Claude Desktop `claude_desktop_config.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mails": {
      "command": "npx",
      "args": ["-y", "@mailsai/mcp-server"],
      "env": { "MAILS_API_KEY": "mk_live_or_test_xxx" }
    }
  }
}
```

That's it — your agent now has 20 email tools. Get a key at [mails.ai](https://mails.ai).

## Tools

**Send** — `mails.send` · `mails.reply` · `mails.forward` · `mails.create_draft` · `mails.send_draft`
**Inbox (the two-way half)** — `mails.list_received` · `mails.get_received` · `mails.list_replies` · `mails.list_messages` · `mails.get_event` · `mails.list_threads` · `mails.get_thread`
**Firewall** — `mails.get_reputation` (sending health, auto-suspend watch) · `mails.check_suppression` · `mails.allowlist_address` · `mails.test_inbound` (sandbox: fire a simulated inbound through the real injection scanner)
**Agents & account** — `mails.create_agent` · `mails.list_agents` · `mails.me` · `mails.get_usage`

## Config

| Env var | Required | Default |
|---|---|---|
| `MAILS_API_KEY` | yes | — (`mk_live_…` or `mk_test_…`) |
| `MAILS_BASE_URL` | no | `https://api.mails.ai` |

A `mk_test_…` key exercises the full API shape (real ids, real firewall, real events) without touching a mail server, billing, or your sending reputation — the right key to build and demo against.

## License

MIT · [mails.ai](https://mails.ai)
