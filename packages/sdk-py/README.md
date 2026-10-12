# mailsai

Email API for AI agents — Python SDK.

Per-agent email addresses on your domain, per-agent reputation, and prompt-injection scanning on inbound mail. Your agent reads the reply and decides what to say — intent + entity extraction is opt-in.

```bash
pip install mailsai
```

## Quick start

No domain to verify, no DNS. Signup gave your workspace an agent called `hello`; `from` picks
the sender, and on a paid plan a new name creates another agent on first use.

```python
from mailsai import Client

# Reads MAILS_API_KEY from env (or pass api_key=... explicitly)
client = Client()

# Send transactional mail: something the recipient asked for.
sent = client.send(**{
    "from": "hello",
    "to": "you@example.com",
    "subject": "Your verification code is 481902",
    "body": "Your verification code is 481902. It expires in 15 minutes.",
})

print(sent["from"])   # hello@<your-workspace>.mails.ai: the agent that sent it, by its API address
```

A **test key** (`mk_test_…`) runs that entire path — validation, the firewall, threading,
events, webhooks — and delivers nothing, so you can integrate before you decide anything. On a
test key, check `sent.get("classifier_warning")`: it is how a sandbox send tells you the same
message would be refused on a live key.

Already have an agent, or want to name it explicitly? Both of these still work:

```python
client.create_agent("sarah")            # explicit creation, when you want it
client.send("sarah", to="…", subject="…", body="…")
```

Note the free plan allows **one** agent. If `from` names a second one and there is no room,
the send is refused with `402 plan_limit_exceeded` naming the agent you do have — it is never
quietly sent under a different identity.

```python
from mailsai import agent

sarah = agent("sarah")

@sarah.on_reply
def handle(reply):
    # A reply is scanned for prompt injection:
    # reply["injection_score"]   -> 0.02   # 0 to 1; at 0.95 or more it is marked quarantined
    # reply["quarantined"]       -> False
    #
    # A reply is not read for intent: that is for new mail (the message.received events
    # stream_events delivers) to an agent with classify_inbound on (Pro and Scale include
    # it at no extra charge). So on every reply:
    # reply["intent"]            -> "general_reply"
    # reply["sender_reputation"] -> 0.85   # 0.3 when the reply scores as an injection
    #                                      # attempt, 0.5 when it could not be scanned
    #
    # Your agent reads the reply and decides what to send next.
    print(reply["injection_score"], reply["quarantined"])

sarah.start_listening()  # blocks; opens SSE stream and dispatches replies
```

For non-blocking, pass `blocking=False` to `start_listening()` — it returns a daemon thread.

## Events

`list_events()`, `stream_events()` and webhooks carry these types. Inbound: `reply.received`,
`message.received`, `message.received.unauthenticated` (a forged sender: no DKIM signature aligned
with the From domain verifies, and that domain's DMARC policy is quarantine or reject) and
`message.received.over_limit` (mail received while the workspace was over a limit; it carries no
subject or body). Outbound: `message.sent`, `message.scheduled`, `message.delivered`,
`message.delayed` (a transient bounce), `message.bounced`, `message.complained` and
`message.failed` (a scheduled send that ended without going out). Drafts: `draft.scheduled`,
`draft.sending`, `draft.sent`, `draft.failed`. Also `suppression.added`, `webhook.test`,
`thread.created`, `thread.updated` and `thread.deleted`. A `"*"` webhook gets the thread events
and `message.delayed` only when it names them.

An inbound event's `data` says how the sender was authenticated, checked from the email itself and
never from a header in it: `dkim` (`pass`, `fail`, `none` for an unsigned email, or `unknown`),
`dkim_domain` (the domain of the passing signature that matches From, or None), `dmarc` (`pass`,
`none`, or `unknown`; `fail` is not reported while SPF cannot be checked), `spf` (`unknown` for
now) and `auth_failed` (True only on `message.received.unauthenticated`). It also says who the
email is from. `from` is a dict with `address` and `name`, the first mailbox of the From header:
the address those checks are about, and the one a reply goes to when there is no Reply-To.
`envelope_from` is the envelope sender, where bounces go, often a sending service's own address.
`arc` is the email's ARC chain as we checked it, and `trusted_forwarder` names the mail service
whose ARC seal vouched for the original sender of forwarded mail, or None.

## Lower-level client

```python
from mailsai import create_client

c = create_client()  # reads MAILS_API_KEY

# Send via any agent
c.send("sarah", to="user@example.com", subject="Your receipt", body_text="…")

# Resources
threads = c.list_threads(agent_id="sarah")  # an agent's name or id (agt_…)
usage = c.usage()
rep = c.get_reputation(agent_id="sarah")

# Drafts
draft = c.create_draft(agent="sarah", to="user@example.com", subject="Your receipt", body_text="…")
c.send_draft(draft["id"])
```

Search, labels and attachments:

```python
from datetime import datetime, timezone

hits = c.search("invoice", type="received", has_attachment=True, after=datetime(2026, 10, 1, tzinfo=timezone.utc))

vip = c.create_label("VIP", color="red")
c.update_thread(hits["data"][0]["thread_id"], label_ids=[vip["id"]])

files = c.list_attachments(hits["data"][0]["id"])
data = c.download_attachment(hits["data"][0]["id"], files["data"][0]["id"])  # bytes
with open(files["data"][0]["filename"], "wb") as f:
    f.write(data)
```

Booleans go to the API as `true`/`false` (`c.list_threads(read=False)`), and `from`, a Python
keyword, is written `from_` in `search`, `get_metrics`, `test_inbound`, `list_received` and
`wait_for_received`.

`list_events(since=…)` (and `agent.list_replies(since=…)`, `list_received` and `wait_for_received`) takes a `datetime` or an ISO 8601
string and sends it in the form every `created_at` has (`2026-10-04T09:30:00.000Z`); a naive
datetime, or a string with no offset, is UTC. A plain date such as `2026-10-04` is sent as it
is. A value that is not a time raises `MailsError` (`param == "since"`) before any request is
made, as the API would answer it 400. `stream_events(since=…)` is different: it takes
a position the stream gave, or an event id (`evt_…`), to resume from.

`stream_events()` reconnects by itself, from where the server said the stream was, and does not
hand `on_event` the same event twice while it runs. Events arrive in id order, except one that was
written late: it arrives after newer ones instead of being skipped. To carry on after a restart,
save the position `on_position` gives you and pass it as `since`: an event id starts after that
event, and a position starts exactly where the stream was. Across a restart delivery is at least
once, so keep the event ids you handled if handling one twice would matter.

## Every method

All of these are on `Client` (from `Client()` or `create_client()`), and each returns the API's
JSON as a dict unless the table says otherwise.

**Messages you send**

| Method | API call |
|---|---|
| `send(agent=None, **fields)` | `POST /v1/messages` |
| `batch_send(messages, idempotency_key=None)` | `POST /v1/messages/batch` |
| `list_messages(limit, cursor, agent_id, thread_id, q)` | `GET /v1/messages` |
| `get_message(message_id)` | `GET /v1/messages/{id}` |
| `reply(message_id, body=…, idempotency_key=None, **fields)` | `POST /v1/messages/{id}/reply` |
| `forward(message_id, to=…, idempotency_key=None, **fields)` | `POST /v1/messages/{id}/forward` |
| `reschedule_message(message_id, scheduled_at)` | `PATCH /v1/messages/{id}` |
| `cancel_message(message_id)` | `POST /v1/messages/{id}/cancel` |
| `get_raw_message(message_id)`, the message as an RFC 822 `str` | `GET /v1/messages/{id}/raw` |
| `appeal(agent=None, subject=…, body=…)` | `POST /v1/messages/appeal` |

**Mail you receive**

| Method | API call |
|---|---|
| `list_received(limit, cursor, agent_id, thread_id, q, from_, since)` | `GET /v1/messages/received` |
| `wait_for_received(agent_id, from_, since, has, timeout)`, the newest match as soon as it arrives | `GET /v1/messages/received/wait` |
| `get_received(id)` | `GET /v1/messages/received/{id}` |
| `list_attachments(message_id)` | `GET /v1/messages/received/{id}/attachments` |
| `download_attachment(message_id, attachment_id, inline=False)`, the file as `bytes` | `GET /v1/messages/received/{id}/attachments/{attachment_id}` |
| `test_inbound(agent, from_=…, body_text=…, **fields)`, test keys only | `POST /v1/test/inbound` |

**Threads, labels and search**

| Method | API call |
|---|---|
| `list_threads(limit, cursor, agent_id, status, folder, read, label, q)` | `GET /v1/threads` |
| `get_thread(thread_id)`, with its messages | `GET /v1/threads/{id}` |
| `update_thread(thread_id, labels=…, label_ids=…, status=…, read=…, folder=…)` | `PATCH /v1/threads/{id}` |
| `delete_thread(thread_id, permanent=False)`, to trash or for good | `DELETE /v1/threads/{id}` |
| `list_labels()` | `GET /v1/labels` |
| `create_label(name, color=None)` | `POST /v1/labels` |
| `get_label(label_id)` | `GET /v1/labels/{id}` |
| `update_label(label_id, name=None, color=None)` | `PATCH /v1/labels/{id}` |
| `delete_label(label_id)` | `DELETE /v1/labels/{id}` |
| `search(q=None, agent_id, from_, to, after, before, has_attachment, folder, label, type, limit, cursor)` | `GET /v1/search` |

To restore a trashed thread, move it back: `update_thread(thread_id, folder="inbox")`.

**Drafts**

| Method | API call |
|---|---|
| `create_draft(**fields)` | `POST /v1/drafts` |
| `list_drafts(limit, cursor, agent_id, status)` | `GET /v1/drafts` |
| `get_draft(draft_id)` | `GET /v1/drafts/{id}` |
| `update_draft(draft_id, **fields)` | `PATCH /v1/drafts/{id}` |
| `delete_draft(draft_id)` | `DELETE /v1/drafts/{id}` |
| `send_draft(draft_id, send_at=None, idempotency_key=None)` | `POST /v1/drafts/{id}/send` |

**Agents**

| Method | API call |
|---|---|
| `create_agent(name, domain=None, allowlist_domains=None, …)`, or `create_agent(address=…, forwarding=True)` for an address on your own verified domain | `POST /v1/agents` |
| `list_agents(limit, cursor, status)` | `GET /v1/agents` |
| `get_agent(agent_id)` | `GET /v1/agents/{id}` |
| `update_agent(agent_id, **fields)` | `PATCH /v1/agents/{id}` |
| `archive_agent(agent_id)` | `DELETE /v1/agents/{id}` |
| `get_agent_inbox(agent_id)`, unread and thread counts per folder and label | `GET /v1/agents/{id}/inbox` |
| `verify_agent_forwarding(agent_id)`, one test email through a forwarding-mode agent's forward | `POST /v1/agents/{id}/forwarding/verify` |

**Events and webhooks**

| Method | API call |
|---|---|
| `list_events(limit, cursor, event_type, agent_id, since)` | `GET /v1/events` |
| `get_event(event_id)` | `GET /v1/events/{id}` |
| `redeliver_event(event_id)` | `POST /v1/events/{id}/redeliver` |
| `stream_events(event_types=None, since=None, on_event=…, on_error=…, stop_event=None, on_position=None)`, blocking | `GET /v1/events/stream` |
| `create_webhook(url, event_types=None, description=None)` | `POST /v1/webhooks` |
| `list_webhooks(limit, cursor)` | `GET /v1/webhooks` |
| `get_webhook(webhook_id)` | `GET /v1/webhooks/{id}` |
| `update_webhook(webhook_id, **fields)` | `PATCH /v1/webhooks/{id}` |
| `delete_webhook(webhook_id)` | `DELETE /v1/webhooks/{id}` |
| `rotate_webhook_secret(webhook_id)` | `POST /v1/webhooks/{id}/rotate-secret` |
| `list_webhook_deliveries(webhook_id, limit, cursor)` | `GET /v1/webhooks/{id}/deliveries` |
| `test_webhook(webhook_id)` | `POST /v1/webhooks/{id}/test` |
| `replay_webhook_delivery(delivery_id)` | `POST /v1/webhook-deliveries/{id}/replay` |
| `verify_webhook(body, signature, secret)`, a module function; no request | none |

**Domains, keys and suppression**

| Method | API call |
|---|---|
| `create_domain(domain)` | `POST /v1/domains` |
| `list_domains()` | `GET /v1/domains` |
| `get_domain(domain_id)` | `GET /v1/domains/{id}` |
| `verify_domain(domain_id)` | `POST /v1/domains/{id}/verify` |
| `delete_domain(domain_id)` | `DELETE /v1/domains/{id}` |
| `create_api_key(name=None, agent_id=None, scopes=None, mode=None, expires_at=None)` | `POST /v1/api-keys` |
| `list_api_keys(limit, cursor)` | `GET /v1/api-keys` |
| `revoke_api_key(key_id)` | `DELETE /v1/api-keys/{id}` |
| `list_connected_apps(limit, cursor)` | `GET /v1/oauth/grants` |
| `revoke_connected_app(app_id)` | `DELETE /v1/oauth/grants/{id}` |
| `check_suppression(address)` | `GET /v1/suppression?address=…` |
| `list_suppression(view=None, limit, cursor)`, `view="suppressed"` for suppressed recipients | `GET /v1/suppression` |
| `allow_address(address, attestation)` | `POST /v1/suppression/allow` |
| `revoke_allow(entry_id)` | `DELETE /v1/suppression/allow/{id}` |

**Account**

| Method | API call |
|---|---|
| `me()` | `GET /v1/me` |
| `get_metrics(from_, to, agent_id, interval)` | `GET /v1/metrics` |
| `get_reputation(agent_id=None)` | `GET /v1/reputation` |
| `usage()` | `GET /v1/billing/usage` |
| `open_billing_portal(return_url=None, price_lookup_key=None)` | `POST /v1/billing/portal` |
| `list_logs(limit, cursor, category, action)` | `GET /v1/logs` |
| `health()` | `GET /api/health` |

**The agent helper** (`agent(name)`): `send(...)`, `list_replies(limit=10, since=None)`,
`reputation()`, the `@on_reply` decorator, `start_listening(blocking=True)` and
`stop_listening()`. `name` is the agent's name or its id (`agt_…`). When two agents share a
name (one at `<workspace>.mails.ai` and one on your own domain), a key tied to one of them
means that one. A workspace key sends from the older one, and its reads and listeners are
refused with 409 `agent_name_conflict`: pass the id instead. `start_listening` looks the
agent up before it opens the stream; if that fails (the conflict, or a name no agent has) it
prints the reason to stderr and returns.

**A key tied to one agent** (`create_api_key(agent_id=...)`) reads and sends as that agent
only. Calls that read across the whole workspace (`usage()`, `list_logs()`,
`list_connected_apps()`) or change it (webhooks, labels, domains, connected apps, revoking
keys, creating agents, send-anyway entries) raise `MailsError` with status 403 and code
`insufficient_scope`. `get_metrics()` counts only that agent's mail, and naming another agent
in `agent_id` raises the same error. `list_agents()` returns that agent only, `list_api_keys()`
only the keys tied to it, and `get_agent()` of any other agent raises `MailsError` with status
404 and code `agent_not_found`, as if it did not exist.

## Rate limits and retries

A rate-limited call (429) is retried up to three times, and so is a 5xx or a lost connection on a
read or on one of the five sends (`send`, `batch_send`, `reply`, `forward`, `send_draft`), which
always carry an idempotency key. Any other write is sent once: sending it again could act twice.
The API sends `Retry-After` only when the limit lifts within 60 seconds, and the client sleeps
that long, up to `max_retry_wait` (60 seconds by default, and never more than 60;
`Client(max_retry_wait=…)` or `create_client(max_retry_wait=…)`).

When the limit lifts later (an hourly window that will not clear within the minute, a daily or
monthly cap), the error body says when: `resets_at` and `retry_after_seconds`. The client then
does not sleep. It raises `RateLimitError` at once, with `resets_at` (an ISO 8601 time) and
`retry_after_seconds` set and both named in the message. `resets_at` is `None` when waiting
never lifts the limit (a plan cap that only an upgrade does). `RateLimitError` is a `MailsError`,
so code that catches `MailsError` still catches it.

`reply`, `forward`, `send_draft` and `batch_send` take `idempotency_key` the same way `send` does:
a retry with the same key returns the first response instead of sending again.

## Sign-up codes and links

A received message carries `codes` and `links`, picked out of its text and HTML by fixed rules, with no AI involved. Each code is a `value`, the likeliest first. Each link is a `url` and a `kind` (`verify`, `sign_in`, `reset_password`, `unsubscribe` or `other`), the action links first.

`wait_for_received()` answers as soon as a matching message arrives, so an agent that has just asked a service for a code reads it in one call:

```python
from datetime import datetime, timezone

asked_at = datetime.now(timezone.utc)
# ...the agent signs up somewhere with its mails.ai address...
found = c.wait_for_received(from_="github.com", has="code", since=asked_at, timeout=50)
code = found["message"]["codes"][0]["value"] if found["message"] else None
```

`from_` is an address or a domain, and a domain includes its subdomains. `has` is `"code"`, or `"link"` for a `verify`, `sign_in` or `reset_password` link. `timeout` is 0 to 50 seconds (default 30), and without `since` it looks back 5 minutes. Mail judged forged and quarantined mail never match. Nothing in time is not an error: `message` is `None` and `timed_out` is `True`. The call waits that long plus 15 seconds before the client gives up on it, whatever the client's own `timeout`.

## Attachments

Up to 10 files and 25 MB in all. Give each file's bytes, or an https URL that mails.ai downloads when it sends, and give a file a `content_id` to show it inside the HTML instead of attaching it. Bytes travel inside the request, so together they can come to about 3 MB: give a larger file by its URL. A batch cannot carry attachments, so send a message with files on its own:

```python
import base64

with open("invoice-221.pdf", "rb") as f:
    pdf = base64.b64encode(f.read()).decode()

sarah.send(
    to="dana@example.com",
    subject="Your invoice",
    body_html='<img src="cid:logo" alt="Acme"><p>Your invoice is attached.</p>',
    attachments=[
        {"filename": "logo.png", "path": "https://files.example.com/logo.png", "content_id": "logo"},
        {"filename": "invoice-221.pdf", "content_base64": pdf, "content_type": "application/pdf"},
    ],
)
```

A `path` must answer within 10 seconds, after at most 3 redirects, each to https, and never at a private, loopback or link-local address. A file that cannot be fetched refuses the whole send with `MailsError` (400 `invalid_field`, `param` naming the file: `attachments.0.path`), and nothing is sent. `content_type` is optional with `path`: the type the URL answers with is used. A send with a future `scheduled_at` cannot carry attachments yet.

## One-click unsubscribe

Sends carry no unsubscribe headers unless you ask. For a newsletter or digest, opt in:

```python
sarah.send(to="reader@example.com", subject="This week's digest", body="…", list_unsubscribe=True)
```

The message then carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and the recipient's mail app shows an Unsubscribe button. One click suppresses that address for your whole workspace, so later sends to it are refused with `recipient_suppressed`. Leave it off for password resets, sign-in links and receipts. It needs exactly one `to` recipient and no `cc` or `bcc`.

## Webhook verification

```python
from mailsai import verify_webhook

# In your webhook handler:
event = verify_webhook(
    body=request.body.decode(),
    signature=request.headers["X-Mails-Signature"],
    secret=os.environ["MAILS_WEBHOOK_SECRET"],
)
if event is None:
    return Response(status=400)
# event is the verified inbound event dict
```

## Errors

```python
from mailsai import MailsError, RateLimitError

try:
    sarah.send(to="blocked@example.com", subject="…", body="…")
except RateLimitError as e:
    print("rate limited until", e.resets_at) if e.resets_at else print(e.message)
except MailsError as e:
    print(e.type, e.code, e.message, e.status, e.request_id)
```

A send that succeeds answers `status` `sent`, `scheduled` (a future `scheduled_at`), or
`delivered` when delivery to every recipient was confirmed at once (with a live key, a send
only to the test address `reply@test.mails.ai` always is; a test key's sends answer `sent`). A
send that fails raises instead.

## Configuration

| Param / env var | Default |
|---|---|
| `api_key` / `MAILS_API_KEY` | (required) |
| `base_url` / `MAILS_BASE_URL` | `https://api.mails.ai` |
| `timeout` | `30` seconds |
| `max_retry_wait` | `60` seconds (at most 60) |

## Documentation

- Full docs: [mails.ai/docs](https://mails.ai/docs)
- Source: [github.com/mailsai/mailsai](https://github.com/mailsai/mailsai/tree/main/packages/sdk-py)

## License

MIT
