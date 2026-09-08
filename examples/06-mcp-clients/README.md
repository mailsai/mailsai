# Give Claude, Cursor or any MCP client an inbox

`@mailsai/mcp-server` exposes 20 tools over [MCP](https://modelcontextprotocol.io) — send,
reply, forward, threads, inbound events, drafts, agents, reputation, suppression, webhooks —
so an assistant can run email itself instead of you writing glue.

## See it work before configuring anything

```bash
MAILS_API_KEY=mk_test_xxx npx -y -p @mailsai/mcp-server mails-mcp-demo
```

That walks the whole loop in the sandbox: an agent gets an inbox, sends, a reply arrives as a
structured event, then a phishing attempt gets scored and refused. Nothing is delivered and
nothing is billed.

## Config

Every MCP client takes the same block. Use a **test key** (`mk_test_…`) while you are wiring
it up — the request path is real, the mail is not.

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

| Client | File |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Claude Code | `claude mcp add mails -e MAILS_API_KEY=mk_test_xxx -- npx -y -p @mailsai/mcp-server mails-mcp` |
| Cursor | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally |
| Cline / Continue / Windsurf | the extension's MCP settings JSON — same block |

Restart the client, and ask it something like *"check my agent's inbox and tell me if anything
looks like a phishing attempt."*

## What the assistant can and cannot do

It can send transactional mail, read its own inbox, thread replies, and inspect reputation.

It **cannot** send cold outreach: every send passes the same firewall the REST API uses, so a
prompt like *"email 50 prospects about our product"* comes back `422 cold_email_prohibited`.
That holds even when the instruction arrives inside an email the assistant is reading — which
is the case that matters, because that is a prompt-injection payload asking your assistant to
spend your sending reputation.

## Scoping the key

An API key can be bound to a single agent, so an assistant configured with it can only ever
send as that agent. Mint one at [mails.ai](https://mails.ai) → API Keys → New key → bind to
agent. Worth doing before you point a live key at anything autonomous.
