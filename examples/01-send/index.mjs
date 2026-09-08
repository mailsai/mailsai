// Send your first email. No agent to create, no domain to verify, no DNS.
//
//   npm install @mailsai/sdk
//   MAILS_API_KEY=mk_test_... node index.mjs
//
// A test key (mk_test_…) runs the entire real request path — validation, the outbound
// firewall, threading, events — and transmits nothing. Swap in an mk_live_… key when you
// want the mail to actually land.

import { createClient } from "@mailsai/sdk";

const mails = createClient(); // reads MAILS_API_KEY

// Every example in this folder sends as the SAME agent, because the free plan allows ONE —
// so the five of them run back to back on a new workspace instead of the second one hitting
// a 402. Already have an agent under another name? `export MAILS_AGENT=<its name>`.
const AGENT = process.env.MAILS_AGENT ?? "assistant";

// `from` names the agent, and one is created on first use. If you already have an agent
// under a different name and are on the free plan, there is no room to mint this one — and
// the API refuses (402 `plan_limit_exceeded`) rather than quietly sending under your other
// agent's identity. Handle it the way you would in your own code: use the agent you have.
// `sent.from` is the receipt — it always names the identity that actually went.
let explained = false;
async function sendAs(input) {
  try {
    return await mails.send(input);
  } catch (err) {
    if (err.code !== "plan_limit_exceeded") throw err;
    const { data: agents } = await mails.listAgents({ limit: 50 });
    const existing = agents.find((a) => a.status !== "archived")?.name;
    if (!existing) throw err;
    if (!explained) {
      console.log(`(your plan allows one agent, so these go as "${existing}" — name it with agent: "${existing}")`);
      explained = true;
    }
    const { from: _named, ...rest } = input;
    return await mails.send({ ...rest, agent: existing });
  }
}

// 1) Transactional mail — something this recipient asked for or is owed.
const sent = await sendAs({
  from: AGENT,
  to: "customer@example.com",
  subject: "Your invoice #221 is ready",
  body: "Hi Dana — invoice #221 for March is attached, due the 30th.",
});

console.log(`${sent.status}  ${sent.id}  from ${sent.from}  $${sent.cost_usd ?? 0}`);

// 2) Cold outreach. mails.ai carries transactional mail only, so this one does not go out.
//
//    On a LIVE key it throws 422 cold_email_prohibited.
//    On a TEST key you get a 201 with `classifier_warning` instead — deliberately, so a
//    sandbox first send can succeed. So on a test key, CHECK THAT FIELD: a test send that
//    says "sent" while carrying a warning is not a message that will ever go out.
try {
  const cold = await sendAs({
    from: AGENT,
    to: "stranger@example.com",
    subject: "Quick question",
    body:
      "Hi — I came across your team and wanted to reach out. Worth a 15-min call to show " +
      "how our platform helps companies boost revenue? Happy to book a demo.",
  });

  if (cold.classifier_warning) {
    const w = cold.classifier_warning;
    console.log(`\nwould be REFUSED on a live key: ${w.reason} (confidence ${w.score})`);
    console.log(`  ${w.message.split(". ")[0]}.`);
  } else {
    console.log("\npassed the firewall — routing_pool:", cold.routing_pool);
  }
} catch (err) {
  // The live-key path: a refusal your agent can read and act on, not a silent drop.
  console.log(`\nrefused as designed: ${err.code} — ${err.message.split(". ")[0]}.`);
}

// The point: the boundary lives in the API, not in your prompt. An agent that was talked
// into sending outreach still cannot send it.
