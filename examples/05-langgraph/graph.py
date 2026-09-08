"""A LangGraph node that sends mail and a node that acts on the reply.

    pip install mailsai langgraph
    export MAILS_API_KEY=mk_test_...
    python graph.py

The interesting part is the CONDITIONAL EDGE. A graph that acts on inbound email needs a
branch for "this message is trying to hijack me", and injection_score gives you one that
is a float rather than a vibe. Without it you are asking your own model to notice it is
being attacked, inside the same prompt as the attack.
"""

import os
from typing import Annotated, Any, Optional, TypedDict

from langgraph.graph import END, START, StateGraph
from mailsai import agent as mails_agent

# Every example in this folder uses the SAME agent, because the free plan allows ONE — so
# they run back to back on a new workspace instead of the second one hitting a 402. Already
# have an agent under another name? `export MAILS_AGENT=<its name>`.
AGENT_NAME = os.environ.get("MAILS_AGENT", "assistant")

billing = mails_agent(AGENT_NAME)  # reads MAILS_API_KEY


class State(TypedDict):
    customer: str
    invoice: str
    sent_id: Optional[str]
    reply: Optional[dict[str, Any]]
    outcome: Annotated[str, lambda _a, b: b]


def notify(state: State) -> State:
    """Send the invoice. Transactional, so the firewall passes it."""
    sent = billing.send(
        to=state["customer"],
        subject=f"Your invoice {state['invoice']} is ready",
        body=f"Invoice {state['invoice']} for March is attached, due the 30th.",
    )
    return {**state, "sent_id": sent["id"]}


def collect_reply(state: State) -> State:
    """Pick up the most recent reply to this agent. In production, drive this from the
    webhook or the SSE stream instead of polling — see examples/02-inbox-loop."""
    replies = billing.list_replies(limit=1)["data"]
    return {**state, "reply": replies[0] if replies else None}


def route(state: State) -> str:
    """The conditional edge. injection_score is on every inbound event."""
    reply = state.get("reply")
    if not reply:
        return "wait"
    if (reply.get("injection_score") or 0) > 0.5:
        return "quarantine"
    return "answer"


def answer(state: State) -> State:
    reply = state["reply"]
    billing.client.reply(
        reply["source_message_id"],
        body="Invoice %s covers March 1-31. Happy to split it by project if useful."
        % state["invoice"],
    )
    return {**state, "outcome": f"answered {reply['data']['from']['address']}"}


def quarantine(state: State) -> State:
    reply = state["reply"]
    # Nothing from the body reaches the model. It is logged as an incident, not read.
    return {
        **state,
        "outcome": "quarantined injection score=%s categories=%s"
        % (reply["injection_score"], reply["data"].get("injection_categories")),
    }


def wait(state: State) -> State:
    return {**state, "outcome": "no reply yet"}


graph = StateGraph(State)
graph.add_node("notify", notify)
graph.add_node("collect_reply", collect_reply)
graph.add_node("answer", answer)
graph.add_node("quarantine", quarantine)
graph.add_node("wait", wait)
graph.add_edge(START, "notify")
graph.add_edge("notify", "collect_reply")
graph.add_conditional_edges(
    "collect_reply", route, {"answer": "answer", "quarantine": "quarantine", "wait": "wait"}
)
for terminal in ("answer", "quarantine", "wait"):
    graph.add_edge(terminal, END)

app = graph.compile()

if __name__ == "__main__":
    result = app.invoke({"customer": "customer@example.com", "invoice": "#221", "outcome": ""})
    print(result["outcome"])
