# Forwarded-email assistant

Forward it a bill or a membership email with one line on top, such as "cancel this", "get me a
refund" or "delete my data". It drafts the request to the company and asks you before it sends
anything. Then it sends the request from its own address, follows up once if the company goes
quiet, and passes the company's answer back to you.

```bash
npm install @mailsai/sdk
MAILS_API_KEY=mk_test_xxx OWNER_EMAIL=you@example.com node index.mjs
```

It prints the address to forward mail to. Only mail from `OWNER_EMAIL` gives it work, and on a
live key only when that mail passes DMARC, so nobody gets an errand done by putting your address
in a From line.

## Try it on a test key

A test key delivers nothing, so you play both sides with `POST /v1/test/inbound`. Keep the
assistant running, and in a second terminal:

```bash
inbound() {
  curl -s -X POST https://api.mails.ai/v1/test/inbound \
    -H "Authorization: Bearer $MAILS_API_KEY" \
    -H "Content-Type: application/json" -d "$1"
}
```

Forward it an email. Gmail, Apple Mail and Outlook forwards are all understood:

```bash
inbound '{
  "agent": "assistant",
  "from": "you@example.com",
  "subject": "Fwd: Your StreamFlix membership renews soon",
  "body_text": "cancel this please\n\n---------- Forwarded message ---------\nFrom: StreamFlix <billing@streamflix.example>\nSubject: Your StreamFlix membership renews soon\n\nYour membership renews on Oct 20 for $15.49."
}'
```

It drafts the request, sends it to you for approval and prints the id of that email. Approve it:

```bash
inbound '{
  "agent": "assistant",
  "from": "you@example.com",
  "subject": "Re: Fwd: Your StreamFlix membership renews soon",
  "body_text": "SEND",
  "in_reply_to_message_id": "<the id it printed>"
}'
```

It sends the request, schedules the follow-up and prints the request's id. Answer as the company:

```bash
inbound '{
  "agent": "assistant",
  "from": "billing@streamflix.example",
  "subject": "Re: Please cancel my subscription",
  "body_text": "Your membership is canceled and you will not be charged again.",
  "in_reply_to_message_id": "<the request id>"
}'
```

The follow-up is canceled, and the company's answer reaches your thread. Answer `STOP` instead
of `SEND` and the draft is deleted with nothing sent.

## Where it keeps its state

In mails.ai, so there is no database to run. The request waits as a draft until you answer.
Tags tie each errand together: `errand_for` names your forward, `draft` names the draft a
question is about, and `answers` marks the message each reply answers. The follow-up is a
scheduled send, canceled when the company answers.

The one local file is `.assistant-position`, its place in the event stream, so a restart picks
up where it stopped. Events can arrive more than once. The `answers` tag and an idempotency key
on every send make a replay harmless.

## Make it yours

The brain is two functions of plain rules, so it runs with no model:

- `errandFor(note)` reads your note and returns `cancel`, `refund`, `delete` or `null`.
- `draftFor({ errand, company, about })` writes the request.

Swap your model in there. Only your note is read as an instruction. The company's answer is
quoted to you and never acted on, and an answer that mails.ai flagged as possibly unsafe, or
could not check, arrives with a warning.

## Before you use it for real

Swap `mk_test_` for `mk_live_` and forward from your real address. If it ignores a forward, its
log says why, and the received message's `dmarc` field shows the result it got.

The request goes from the assistant's address, not yours, and names your account in the body.
Some companies act only on mail from the address on the account. When one says so, its answer
reaches you, and you can send the request yourself.
