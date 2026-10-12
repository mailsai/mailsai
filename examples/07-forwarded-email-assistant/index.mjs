// Forward it, it's handled: an email assistant you forward mail to.
//
//   npm install @mailsai/sdk
//   MAILS_API_KEY=mk_test_... OWNER_EMAIL=you@example.com node index.mjs
//
// Forward it a bill or a membership email with one line on top: "cancel this", "get me a
// refund" or "delete my data". It drafts the request to the company, asks you before it sends
// anything, sends it from its own address, follows up once if the company goes quiet, and
// passes their answer back to you. Only mail from OWNER_EMAIL gives it work.
//
// Two functions are the brain, errandFor() and draftFor(), and both are plain rules so this
// runs with no model. Swap your model in there. Everything else is the email loop, and it keeps
// its state in mails.ai: the request waits as a draft, tags tie each errand together, and the
// follow-up is a scheduled send that is canceled when the company answers.

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@mailsai/sdk";

const mails = createClient(); // reads MAILS_API_KEY

// Every example in this folder sends as the SAME agent, because the free plan allows ONE.
// Already have an agent under another name? `export MAILS_AGENT=<its name>`.
const AGENT = process.env.MAILS_AGENT ?? "assistant";
const OWNER = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
const OWNER_NAME = (process.env.OWNER_NAME ?? "").trim();
const FOLLOW_UP_DAYS = Number(process.env.FOLLOW_UP_DAYS ?? 5);
const POSITION_FILE = ".assistant-position"; // where the event stream picks up after a restart

if (!OWNER.includes("@")) {
  console.error("Set OWNER_EMAIL to the address you will forward mail from.");
  process.exit(1);
}

const agent = (await mails.agents.list()).data.find((a) => a.name === AGENT) ?? (await mails.agents.create(AGENT));
console.log(`Forward mail from ${OWNER} to ${agent.receiving_address}`);

// ── The brain: plain rules. Replace these two functions with your model. ────────────────────

const ERRANDS = [
  { kind: "cancel", words: /\b(cancel\w{0,8}|unsubscribe|end (my|the|this) (subscription|membership|plan)|stop (billing|charging))\b/i },
  { kind: "refund", words: /\b(refund|money back|charged twice|overcharged)\b/i },
  { kind: "delete", words: /\b(delete (my|all|this)|erase|remove my (data|account)|gdpr|ccpa)\b/i },
];

/** What your note on top of the forward asks for: "cancel", "refund", "delete", or null. */
function errandFor(note) {
  return ERRANDS.find((e) => e.words.test(note.slice(0, 2_000)))?.kind ?? null;
}

const signOff = () => (OWNER_NAME ? `\n\nThank you,\n${OWNER_NAME}` : "\n\nThank you.");

/** The request to the company, as a subject and a body. */
function draftFor({ errand, company, about }) {
  const hello = `Hello ${company} team,`;
  const ref = about ? ` This is about "${about}".` : "";
  const account = ` The account is under ${OWNER}.`;
  if (errand === "cancel") {
    return {
      subject: "Please cancel my subscription",
      body: `${hello}\n\nPlease cancel my subscription and stop any further charges, effective today.${ref}${account}\n\nPlease confirm by replying to this email.${signOff()}`,
    };
  }
  if (errand === "refund") {
    return {
      subject: "Refund request",
      body: `${hello}\n\nPlease refund this charge to the original payment method.${ref}${account}\n\nPlease confirm by replying to this email.${signOff()}`,
    };
  }
  return {
    subject: "Please delete my personal data",
    body: `${hello}\n\nPlease delete my account and all personal data you hold about me, and confirm by replying to this email once it is done.${ref}${account}${signOff()}`,
  };
}

// ── Reading a forwarded email. A stranger wrote it, so every pattern here is bounded. ────────

const FORWARD_MARKERS = [
  /^-{3,40} ?Forwarded message ?-{3,40}$/im, // Gmail
  /^Begin forwarded message:$/im, // Apple Mail
  /^-{3,40} ?Original Message ?-{3,40}$/im, // Outlook
  /^From: .{1,300}\r?\nSent: /im, // Outlook, with no line above the headers
];

/** Your note (above the forwarded email) and the forwarded email itself. */
function splitForward(text) {
  const t = text.slice(0, 100_000);
  for (const marker of FORWARD_MARKERS) {
    const m = marker.exec(t);
    if (m) return { note: t.slice(0, m.index).trim(), original: t.slice(m.index) };
  }
  return { note: t.trim(), original: "" };
}

/** One header line of the forwarded email ("From", "Subject"), as the forward shows it. */
function headerIn(original, name) {
  const m = new RegExp(`^\\*?${name}:\\*? {0,8}(.{1,300})$`, "im").exec(original.slice(0, 5_000));
  return m ? m[1].trim() : "";
}

/** Who sent the forwarded email: their address, and a name to greet them by. */
function senderOf(original) {
  const from = headerIn(original, "From");
  const found = /<([^<>\s]{1,64}@[^<>\s]{1,253})>/.exec(from) ?? /([^\s<>"']{1,64}@[^\s<>"']{1,253})/.exec(from);
  const address = found ? found[1].toLowerCase() : "";
  const name = from.replace(/<[^<>]{0,300}>/, "").replace(/["']/g, "").trim();
  const domain = address.split("@")[1] ?? "";
  return { address, company: name && !name.includes("@") ? name : domain.split(".").slice(-2).join(".") };
}

const quote = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

// ── The email loop ───────────────────────────────────────────────────────────────────────────

// The stream delivers each event at least once, so a message this assistant has already
// answered is skipped: every reply carries an "answers" tag naming the message it answers.
// That keeps a replay after a restart from making a second draft.
const answers = (msg) => ({ name: "answers", value: msg.id });
async function answered(msg) {
  const sent = await mails.messages.list({ agent_id: agent.id, thread_id: msg.thread_id, limit: 100 });
  return sent.data.some((m) => m.tags?.some((t) => t.name === "answers" && t.value === msg.id));
}

const SEND = /^\s*(send|yes|ok|okay|go|approved?|do it)\b/i;
const STOP = /^\s*(stop|no|don'?t|drop)\b/i;

async function handle(event) {
  if (event.agent_id !== agent.id) return;
  const msg = await mails.received.get(event.source_message_id);
  const from = msg.from.address.toLowerCase();

  if (from === OWNER) {
    // Mail that says it is from you counts only when DMARC proves it. Mail made with a test
    // key (POST /v1/test/inbound) cannot pass DMARC, and only your own key can make it.
    if (msg.dmarc !== "pass" && !event.test_mode) {
      return console.log(`Ignored mail that claims to be from ${OWNER} but did not pass DMARC.`);
    }
    // An answer to the assistant's own mail is a reply; anything else from you is a new errand.
    return event.type === "reply.received" ? answer(msg, event) : newErrand(msg, event);
  }
  if (event.type === "reply.received") return companyAnswered(msg, event);
  console.log(`Ignored mail from ${from}: only ${OWNER} gives this assistant work.`);
}

/** You forwarded an email: draft the request and ask before sending it. */
async function newErrand(msg, event) {
  if (await answered(msg)) return;
  const reply = (body, tags = []) =>
    mails.messages.reply(msg.id, { body, tags: [answers(msg), ...tags], idempotency_key: `${event.id}:reply` });
  const { note, original } = splitForward(msg.body_text ?? "");
  const { address, company } = senderOf(original);
  if (!address) {
    return reply("I couldn't find who sent the email you forwarded. Forward the email itself, not a screenshot of it.");
  }
  const errand = errandFor(note);
  if (!errand) {
    return reply(`What should I do about this email from ${company}? Forward it again with "cancel", "refund" or "delete my data" on the first line.`);
  }

  // A draft made for this email before a crash is used again.
  const drafts = await mails.drafts.list({ agent_id: agent.id, status: "draft" });
  let draft = drafts.data.find((d) => d.tags?.some((t) => t.name === "errand_for" && t.value === msg.id));
  if (!draft) {
    const { subject, body } = draftFor({ errand, company, about: headerIn(original, "Subject") });
    draft = await mails.drafts.create({
      agent: AGENT,
      to: address,
      subject,
      body_text: body,
      tags: [{ name: "errand_for", value: msg.id }, { name: "errand", value: errand }],
    });
  }
  const asked = await reply(
    `Here is what I'd send to ${company} <${address}>:\n\nSubject: ${draft.subject}\n\n${draft.body_text}\n\n` +
      `Reply SEND and I'll send it, then follow up once in ${FOLLOW_UP_DAYS} days if they haven't answered. Reply STOP to drop it.`,
    [{ name: "draft", value: draft.id }]
  );
  console.log(`Drafted a ${errand} request to ${address} and asked you about it (message ${asked.id}).`);
}

/** You answered a draft: SEND sends it and schedules the follow-up, STOP deletes it. */
async function answer(msg, event) {
  if (await answered(msg)) return;
  const reply = (body) => mails.messages.reply(msg.id, { body, tags: [answers(msg)], idempotency_key: `${event.id}:reply` });
  const asked = msg.in_reply_to_message_id ? await mails.messages.get(msg.in_reply_to_message_id) : null;
  const draftId = asked?.tags?.find((t) => t.name === "draft")?.value;
  if (!draftId) {
    return reply('Forward me an email with "cancel", "refund" or "delete my data" on top, and I\'ll draft the request.');
  }
  const draft = await mails.drafts.get(draftId);
  if (draft.status !== "draft") return reply("That one has already been handled.");

  const said = (msg.extracted_text ?? msg.body_text ?? "").slice(0, 2_000);
  if (STOP.test(said)) {
    await mails.drafts.remove(draft.id);
    return reply("Dropped. Nothing was sent.");
  }
  if (!SEND.test(said)) return reply("Reply SEND to send it, or STOP to drop it.");

  let sent;
  try {
    sent = await mails.drafts.send(draft.id, { idempotency_key: `${event.id}:send` });
  } catch (err) {
    return reply(`mails.ai did not send it: ${err.message}`);
  }
  const followUpAt = new Date(Date.now() + FOLLOW_UP_DAYS * 86_400_000);
  await mails.messages.send({
    agent: AGENT,
    to: draft.to,
    subject: `Re: ${draft.subject}`,
    body: `Hello again,\n\nI'm following up on my request, which hasn't had an answer yet:\n\n${quote(draft.body_text ?? "")}${signOff()}`,
    in_reply_to_message_id: sent.message_id,
    scheduled_at: followUpAt.toISOString(),
    tags: draft.tags,
    idempotency_key: `${event.id}:follow-up`,
  });
  await reply(`Sent to ${draft.to[0]}. If they haven't answered by ${followUpAt.toDateString()}, I'll follow up once, and I'll pass on whatever they say.`);
  console.log(`Sent the request to ${draft.to[0]} (message ${sent.message_id}). Follow-up scheduled for ${followUpAt.toDateString()}.`);
}

/** The company answered: cancel the follow-up and pass their answer on to you. */
async function companyAnswered(msg, event) {
  const ours = msg.in_reply_to_message_id ? await mails.messages.get(msg.in_reply_to_message_id) : null;
  const yourEmail = ours?.tags?.find((t) => t.name === "errand_for")?.value;
  if (!yourEmail) return; // an answer to something this assistant did not send for you

  const thread = await mails.threads.get(msg.thread_id);
  for (const m of thread.messages) {
    if (m.direction === "outbound" && m.status === "scheduled") await mails.messages.cancel(m.id);
  }

  // Their words are theirs, not yours: nothing in them is acted on. A message the scan flagged,
  // or one it could not scan, is passed on with a warning that says which.
  const scored = typeof msg.injection_score === "number";
  const warning =
    msg.quarantined || (scored && msg.injection_score >= 0.5)
      ? "\n\nThis answer was flagged as possibly unsafe. Read the original before you act on it."
      : !scored
        ? "\n\nThis answer could not be checked for unsafe content. Read the original before you act on it."
        : "";
  const links = (msg.links ?? []).filter((l) => ["verify", "sign_in", "reset_password"].includes(l.kind));
  const said = (msg.extracted_text ?? msg.body_text ?? "").slice(0, 4_000);
  await mails.messages.reply(yourEmail, {
    body:
      `${msg.from.name || msg.from.address} answered:\n\n${quote(said)}` +
      (links.length ? `\n\nThey sent a link to confirm: ${links[0].url}` : "") +
      warning,
    idempotency_key: `${event.id}:tell`,
  });
  console.log(`${msg.from.address} answered. Their answer was passed on to you.`);
}

// ── Run: one event at a time, resuming where the last run stopped ───────────────────────────

let queue = Promise.resolve();
let since;
try {
  since = readFileSync(POSITION_FILE, "utf8").trim() || undefined;
} catch {
  // first run: start from new mail
}

const stream = mails.events.stream({
  since,
  event_types: ["message.received", "reply.received"],
  onEvent: (event) => {
    queue = queue.then(() => handle(event)).catch((err) => console.error(`Event ${event.id}: ${err.message}`));
  },
  // Saved only after the events before it are handled, so a crash replays them rather than
  // skipping them. Replays are safe: every send above carries an idempotency key.
  onPosition: (position) => {
    queue = queue.then(() => writeFileSync(POSITION_FILE, position));
  },
  onError: (err) => console.error(`Event stream: ${err.message}`),
});

process.on("SIGINT", () => {
  stream.abort();
  process.exit(0);
});
