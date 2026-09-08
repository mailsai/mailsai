// The thing a send-only API can't do: your agent has an inbox, and it acts on replies.
//
//   npm install @mailsai/sdk
//   MAILS_API_KEY=mk_test_... node index.mjs
//
// Every agent gets a real receiving address the moment it exists:
//   <agent>.<workspace>@in.mails.ai
// Inbound arrives as a STRUCTURED event, not a MIME blob you parse yourself:
// injection_score and sender_reputation on every event, plus intent, entities
// and urgency when you enable classification.

import { createClient } from "@mailsai/sdk";

const mails = createClient();

// Every example in this folder sends as the SAME agent, because the free plan allows ONE —
// so the five of them run back to back on a new workspace instead of the second one hitting
// a 402. Already have an agent under another name? `export MAILS_AGENT=<its name>`.
const AGENT = process.env.MAILS_AGENT ?? "assistant";

const support = mails.agent(AGENT);

// 1) React to replies as they land. This is a long-lived SSE stream — it stays
//    open, so run it in a worker, not in a request handler.
const stream = support.onReply(async (event) => {
  // ALWAYS present, the security + identity layer:
  //   event.injection_score    0-1, six-category prompt-injection scan
  //   event.sender_reputation  0-1, this sender's history
  if ((event.injection_score ?? 0) > 0.5) {
    console.log("⚠ refusing to act — injection score", event.injection_score, event.data.injection_categories);
    return; // your model never sees an unlabelled attack
  }

  // Present when classification is enabled:
  //   event.intent    "ask_question" | "schedule_meeting" | "decline" | …
  //   event.entities  { invoice: "221", date: "2026-05-16", … }
  console.log("reply from", event.data.from?.address, "→", event.intent ?? "(classification off)");

  if (event.intent === "ask_question") {
    // Reply IN THREAD — same Message-ID chain, so it lands in the existing
    // conversation in their mail client instead of starting a new one.
    await mails.messages.reply(event.source_message_id, {
      body: "Good question — invoice #221 covers March 1–31. Full breakdown attached.",
    });
  }
});

// 2) Or poll, if a long-lived stream doesn't fit your runtime. Same fields.
const recent = await support.listReplies({ limit: 5 });
for (const e of recent.data) {
  console.log(e.created_at, e.type, "injection:", e.injection_score, "reputation:", e.sender_reputation);
}

// Close the stream when your worker shuts down.
process.on("SIGINT", () => stream.abort());
