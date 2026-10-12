# @mailsai/mcp-server

**Give your AI agent a real inbox it can't be phished through, and a sender it can't torch.**

An [MCP](https://modelcontextprotocol.io) server that drops email into any agent runtime — Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, or your own MCP client. Your agent can **send, receive, and thread** email, and inbound mail runs through a **reputation + prompt-injection firewall** before it ever reaches your model.

Most "email for agents" is a send API. The two things a raw API (SES, Resend) *doesn't* give an autonomous agent are the two things that actually bite you:

- **A real inbox.** Agents don't just send — they receive, thread, and act on replies. You get structured inbound events (an `injection_score` on each; an `intent` and `entities` on new mail, for an agent with classification on), not a raw MIME blob to parse yourself.
- **A firewall.** An agent reading email is an attack surface (prompt injection) and a liability (a looping agent can torch your sending reputation in minutes). Inbound mail is injection-scanned; every send is reputation-checked, and an agent that crosses a **0.3% complaint rate auto-suspends**.

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
       event              reply.received
       intent             general_reply
       injection_score    ····················  0.01
       verdict            ✓ clean — safe for your agent to act on
  5. A PHISHING email tries to hijack your agent — the firewall catches it FIRST
       from               totally-legit@evil.example
       injection_score    ████████████████████  0.99
       categories         instruction_override, data_exfil, tool_invocation
       quarantined        true — our verdict: do not act on this
       → your agent       sees injection_score + refuses to act on it — the attack never reaches your model unlabeled
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

That's it — your agent now has the whole mails.ai API as tools. Get a key at [mails.ai](https://mails.ai).

No install at all: the same tools are served at `https://api.mails.ai/mcp` (Streamable HTTP). Clients that support it sign in to mails.ai there (OAuth); others send an API key as `Authorization: Bearer mk_…`.

## Tools

Every operation of the [mails.ai API](https://mails.ai/docs) is a tool except four: the live event stream (`mails_events_list` with `since` reads the same events), the billing portal (tool output carries no billing links), and the two unsubscribe routes a recipient's link opens. The tools the server started with keep their arguments, so calls saved in a client keep working; every other operation is generated from the API's OpenAPI document, so a new API operation becomes a tool in the next release.

Tool names use `_`, not `.`: since 0.3.0 `mails.send` is `mails_send`, because the Claude and OpenAI APIs accept only letters, digits, `_` and `-` in a tool name, and frameworks that pass names through (the Vercel AI SDK, LangGraph, the OpenAI Agents SDK) failed on the dot. A call by an old dotted name still works and does the same thing; the tool list shows only the new names.

Which tools a connection lists depends on its credential: without the `send` scope there are no sending tools, without `manage` no changes to agents, labels, webhooks, domains or keys; `mails_test_inbound` is listed only for a test key; a key with only the `draft` scope lists the draft tools and cannot send; a key tied to one agent lists neither the tools that change the whole workspace nor those that read across it (`mails_get_usage`, `mails_logs_list`, `mails_connected_apps_list`), whose routes answer such a key 403 `insufficient_scope`, and its `mails_metrics_get` counts only its own agent's mail; and an app connected by signing in, other than the mails CLI, cannot create API keys or webhooks, rotate a webhook's secret, change where a webhook sends, list or revoke the connected apps, or delete mail for good (it can move mail to trash). `mails_me` reports how many tools the current credential can use.

The hints are the MCP tool annotations: **read-only** tools change nothing; **destructive** ones cannot be undone (a deletion, a send: mail cannot be recalled); **idempotent** ones can be repeated with the same effect; **open world** ones reach outside the workspace (they send mail or call a webhook).

<!-- tools:start (generated by scripts/gen-mcp-tools.ts) -->
**Sent mail**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_send` | Send an email |  | yes |  | yes |
| `mails_reply` | Reply to an email |  | yes |  | yes |
| `mails_forward` | Forward an email |  | yes |  | yes |
| `mails_emails_list` | List sent emails | yes |  | yes |  |
| `mails_emails_send_batch` | Send a batch of emails |  | yes |  | yes |
| `mails_emails_appeal` | Appeal a refused send |  |  | yes |  |
| `mails_emails_get` | Get a sent email | yes |  | yes |  |
| `mails_emails_reschedule` | Reschedule an email |  |  | yes |  |
| `mails_emails_cancel` | Cancel a scheduled email |  | yes | yes |  |
| `mails_emails_raw` | Get an email as RFC 822 | yes |  | yes |  |

**Received mail**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_list_received` | List received emails | yes |  | yes |  |
| `mails_get_received` | Get a received email | yes |  | yes |  |
| `mails_list_replies` | List replies | yes |  | yes |  |
| `mails_list_messages` | List first-contact mail | yes |  | yes |  |
| `mails_test_inbound` | Simulate a received email (test key) |  |  |  |  |
| `mails_wait_for_email` | Wait for an email | yes |  | yes |  |
| `mails_attachments_list` | List a received email's attachments | yes |  | yes |  |
| `mails_attachments_get` | Download an attachment | yes |  | yes |  |

**Threads**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_list_threads` | List threads | yes |  | yes |  |
| `mails_get_thread` | Get a thread | yes |  | yes |  |
| `mails_threads_update` | Update a thread |  |  | yes |  |
| `mails_threads_delete` | Delete a thread |  | yes | yes |  |

**Drafts**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_create_draft` | Create a draft |  |  |  | yes |
| `mails_send_draft` | Send a draft |  | yes |  | yes |
| `mails_drafts_list` | List drafts | yes |  | yes |  |
| `mails_drafts_get` | Get a draft | yes |  | yes |  |
| `mails_drafts_update` | Update a draft |  |  | yes | yes |
| `mails_drafts_delete` | Delete a draft |  | yes | yes |  |

**Agents**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_list_agents` | List agents | yes |  | yes |  |
| `mails_create_agent` | Create an agent |  |  |  |  |
| `mails_agents_get` | Get an agent | yes |  | yes |  |
| `mails_agents_update` | Update an agent |  | yes | yes |  |
| `mails_agents_archive` | Archive an agent |  | yes | yes |  |
| `mails_agents_verify_forwarding` | Test an agent's forwarding |  | yes |  | yes |
| `mails_agents_inbox` | Get an agent's inbox summary | yes |  | yes |  |

**Labels**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_labels_list` | List labels | yes |  | yes |  |
| `mails_labels_create` | Create a label |  |  |  |  |
| `mails_labels_get` | Get a label | yes |  | yes |  |
| `mails_labels_update` | Update a label |  |  | yes |  |
| `mails_labels_delete` | Delete a label |  | yes | yes |  |

**Search**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_search_mail` | Search mail | yes |  | yes |  |

**Events**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_get_event` | Get an event | yes |  | yes |  |
| `mails_events_list` | List events | yes |  | yes |  |
| `mails_events_redeliver` | Redeliver an event |  |  |  | yes |

**Webhooks**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_webhooks_list` | List webhook endpoints | yes |  | yes |  |
| `mails_webhooks_create` | Create a webhook endpoint |  |  |  | yes |
| `mails_webhooks_get` | Get a webhook endpoint | yes |  | yes |  |
| `mails_webhooks_update` | Update a webhook endpoint |  |  | yes | yes |
| `mails_webhooks_delete` | Delete a webhook endpoint |  | yes | yes |  |
| `mails_webhooks_rotate_secret` | Rotate a webhook's signing secret |  | yes |  |  |
| `mails_webhooks_list_deliveries` | List webhook delivery attempts | yes |  | yes |  |
| `mails_webhooks_test` | Send a test event to a webhook |  |  |  | yes |
| `mails_webhooks_replay_delivery` | Replay a webhook delivery |  |  |  | yes |

**Domains**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_domains_list` | List custom domains | yes |  | yes |  |
| `mails_domains_create` | Add a custom domain |  |  |  |  |
| `mails_domains_get` | Get a custom domain | yes |  | yes |  |
| `mails_domains_delete` | Remove a custom domain |  | yes | yes |  |
| `mails_domains_verify` | Verify a custom domain |  |  |  |  |

**API keys**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_api_keys_list` | List API keys | yes |  | yes |  |
| `mails_api_keys_create` | Create an API key |  |  |  |  |
| `mails_api_keys_revoke` | Revoke an API key |  | yes | yes |  |

**Suppression**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_check_suppression` | Check whether an address is suppressed | yes |  | yes |  |
| `mails_allowlist_address` | Allowlist a suppressed address |  | yes |  |  |
| `mails_suppressions_list` | List the suppression allowlist | yes |  | yes |  |
| `mails_suppressions_revoke` | Revoke an allowlist entry |  | yes | yes |  |

**Account**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_get_reputation` | Get an agent's sending reputation | yes |  | yes |  |
| `mails_get_usage` | Get billing-period usage | yes |  | yes |  |
| `mails_me` | Get the connected account | yes |  | yes |  |
| `mails_metrics_get` | Get mail metrics | yes |  | yes |  |
| `mails_logs_list` | List audit logs | yes |  | yes |  |
| `mails_health_check` | Check the API's health | yes |  | yes |  |

**Connected apps**

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `mails_connected_apps_list` | List connected apps | yes |  | yes |  |
| `mails_connected_apps_revoke` | Revoke a connected app |  | yes | yes |  |

Not tools (4):

- `GET /v1/events/stream`: a server-sent event stream that stays open, which a tool call cannot return; mails_events_list with `since` reads the same events.
- `POST /v1/billing/portal`: its answer is a billing or checkout link, and MCP tool output carries no plan, upgrade or checkout links.
- `GET /v1/unsubscribe`: the page a recipient lands on from an unsubscribe link, authorised by the link's token rather than a credential.
- `POST /v1/unsubscribe`: the one-click unsubscribe a recipient's mail client sends, authorised by the link's token rather than a credential.
<!-- tools:end -->

## Config

| Env var | Required | Default |
|---|---|---|
| `MAILS_API_KEY` | yes | — (`mk_live_…` or `mk_test_…`) |
| `MAILS_BASE_URL` | no | `https://api.mails.ai` |

A `mk_test_…` key exercises the full API shape (real ids, real firewall, real events) without touching a mail server, billing, or your sending reputation — the right key to build and demo against.

## License

MIT · [mails.ai](https://mails.ai)
