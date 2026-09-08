# mailsai

Email API for AI agents — Python SDK.

Per-agent email addresses on your domain, per-agent reputation, and prompt-injection scanning on every inbound. Your agent reads the reply and decides what to say — intent + entity extraction is opt-in.

```bash
pip install mailsai
```

## Quick start

No agent to create, no domain to verify, no DNS. `from` names the sender and the agent is
created on first use.

```python
from mailsai import Client

# Reads MAILS_API_KEY from env (or pass api_key=... explicitly)
client = Client()

# mails.ai is transactional-only: mail the recipient asked for. Cold outreach and bulk
# marketing are refused with 422 cold_email_prohibited — that is deliberate, and it is
# what keeps the sending reputation clean for everyone on the platform.
sent = client.send(**{
    "from": "sarah",
    "to": "you@example.com",
    "subject": "Your verification code is 481902",
    "body": "Your verification code is 481902. It expires in 15 minutes.",
})

print(sent["from"])   # sarah@<your-workspace>.mails.ai — which identity actually sent
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
    # Always present — the delivery + security + identity layer:
    # reply["injection_score"]   -> 0.02   # six-category prompt-injection scan
    # reply["sender_reputation"] -> 0.91   # per-agent reputation
    #
    # Present only when classification is enabled (opt-in, +$0.003/inbound):
    # reply["intent"]            -> "schedule_demo" | "ask_question" | …
    # reply["entities"]          -> {"date": "...", "time": "..."}
    # reply["urgency"]           -> 0.8
    #
    # Your agent reads the reply and decides what to send next.
    print(reply["injection_score"], reply["sender_reputation"])

sarah.start_listening()  # blocks; opens SSE stream and dispatches replies
```

For non-blocking, pass `blocking=False` to `start_listening()` — it returns a daemon thread.

## Lower-level client

```python
from mailsai import create_client

c = create_client()  # reads MAILS_API_KEY

# Send via any agent
c.send("sarah", to="lead@example.com", subject="Demo", body_text="…")

# Resources
threads = c.list_threads(agent_id="agent_abc123")
usage = c.usage()
rep = c.get_reputation(agent_id="agent_abc123")

# Drafts
draft = c.create_draft(agent="sarah", to="lead@example.com", subject="Demo", body_text="…")
c.send_draft(draft["id"])
```

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
from mailsai import MailsError

try:
    sarah.send(to="blocked@example.com", subject="…", body="…")
except MailsError as e:
    print(e.type, e.code, e.message, e.status, e.request_id)
```

## Configuration

| Param / env var | Default |
|---|---|
| `api_key` / `MAILS_API_KEY` | (required) |
| `base_url` / `MAILS_BASE_URL` | `https://api.mails.ai` |

## Documentation

- Full docs: [mails.ai/docs](https://mails.ai/docs)
- Source: [github.com/mailsai/mailsai](https://github.com/mailsai/mailsai/tree/main/packages/sdk-py)

## License

MIT
