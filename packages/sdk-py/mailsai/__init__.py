"""
Mails.ai — Email API for AI agents (Python SDK).

Quick start:

    from mailsai import agent

    sarah = agent("sarah")  # sarah@yourcompany.mails.ai
    sarah.send(to="lead@example.com", subject="Demo", body="Hi…")

    @sarah.on_reply
    def handle(event):
        # event["intent"]            -> "schedule_demo"
        # event["entities"]          -> {"date": "...", "time": "..."}
        # event["urgency"]           -> 0.8
        # event["injection_score"]   -> 0.02   (the evidence)
        # event["quarantined"]       -> False  (our VERDICT — gate on this)
        # event["sender_reputation"] -> 0.91
        if event.get("quarantined"):
            return  # we judged it an attack; don't act on it
        print(event["intent"], event["entities"])

    sarah.start_listening()  # blocks; runs SSE consumer
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
import os
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Union
from urllib.parse import urlencode

try:
    import httpx  # type: ignore
except ImportError:  # pragma: no cover
    httpx = None  # streaming + main client both require httpx

# Single source of truth is pyproject.toml. A hardcoded literal here silently drifted on
# the first version bump (metadata said 0.1.1, this said 0.1.0) and it rides the
# User-Agent header, so the drift also misreports the client version server-side.
try:  # installed normally
    from importlib.metadata import PackageNotFoundError, version as _pkg_version

    __version__ = _pkg_version("mailsai")
except Exception:  # running from a source checkout, or metadata unavailable
    __version__ = "0.1.1"
__all__ = [
    "agent",
    "Agent",
    "Client",
    "MailsError",
    "verify_webhook",
    "create_client",
    "__version__",
]

DEFAULT_BASE = "https://api.mails.ai"
DEFAULT_TIMEOUT = 30.0
# Bounded exponential backoff for transient failures (429 / retry-safe 5xx).
_MAX_RETRIES = 3
_RETRY_BASE = 0.5
_RETRY_CAP = 8.0


class MailsError(Exception):
    """Raised on any non-2xx response from the Mails.ai API."""

    def __init__(
        self,
        type: str,
        code: str,
        message: str,
        status: int = 0,
        request_id: Optional[str] = None,
        param: Optional[str] = None,
    ):
        super().__init__(message)
        self.type = type
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.param = param


def _require_httpx() -> Any:
    if httpx is None:
        raise RuntimeError(
            "The mailsai Python SDK requires httpx. Install it with: pip install 'mailsai[http]' "
            "or pip install httpx"
        )
    return httpx


def _fold_body(kwargs: Dict[str, Any]) -> None:
    """Fold the ergonomic aliases into the canonical fields, in place.

    `body` is an SDK-level convenience the TypeScript client has always had
    (`body_text: input.body_text ?? input.body`), and `text`/`html` are the Resend-shaped
    aliases the API accepts. This client had NEITHER on Client.send() — only on the
    Agent.send() helper — so the exact snippet in our own README, `send(**{"from": …,
    "body": …})`, reached the server with an unknown `body` field and came back
    "At least one of html (or body_html) and text (or body_text) is required".
    Explicit canonical fields always win.
    """
    text = kwargs.pop("body", None)
    if kwargs.get("body_text") is None and kwargs.get("text") is None and text is not None:
        kwargs["body_text"] = text


class Client:
    """Low-level Mails.ai REST client."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.api_key = api_key or os.environ.get("MAILS_API_KEY") or ""
        self.base_url = (base_url or os.environ.get("MAILS_BASE_URL") or DEFAULT_BASE).rstrip("/")
        self.timeout = timeout
        if not self.api_key:
            raise MailsError(
                "invalid_request_error",
                "missing_api_key",
                "MAILS_API_KEY env var or api_key argument required.",
            )

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": f"mailsai-python/{__version__}",
        }
        if extra:
            h.update(extra)
        return h

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        httpx_mod = _require_httpx()
        url = f"{self.base_url}{path}"
        merged_headers = self._headers(headers)
        data = json.dumps(body).encode() if body is not None else None
        # Retry-safe when a resend can't double-apply: a 429 was rejected (never
        # processed); 5xx only for read methods or when an Idempotency-Key makes a
        # resend a server-side no-op.
        idempotent_method = method in ("GET", "HEAD")
        has_idem_key = any(k.lower() == "idempotency-key" for k in merged_headers)
        # A POST that reaches the server may be PROCESSED even if we never see the
        # response (timeout, dropped connection). Without an Idempotency-Key the caller's
        # natural reaction — retry — sends the email twice. Generate one so a resend is a
        # server-side no-op. Callers who pass their own key keep full control.
        if method == "POST" and not has_idem_key:
            merged_headers["Idempotency-Key"] = f"sdk-{uuid.uuid4()}"
            has_idem_key = True

        attempt = 0
        while True:
            try:
                r = httpx_mod.request(
                    method, url, headers=merged_headers, content=data, timeout=self.timeout
                )
            except Exception as exc:  # httpx.TimeoutException, ConnectError, …
                # Never leak a raw httpx traceback: callers catch MailsError, and a bare
                # transport exception carries no request id and no guidance on whether the
                # call landed. Retry only when a resend cannot double-apply.
                if attempt < _MAX_RETRIES and (idempotent_method or has_idem_key):
                    time.sleep(min(_RETRY_CAP, _RETRY_BASE * (2 ** attempt)))
                    attempt += 1
                    continue
                raise MailsError(
                    "connection_error",
                    "transport_error",
                    f"{method} {path} could not complete: {exc}. The request may or may "
                    "not have been processed — retry with the same Idempotency-Key rather "
                    "than issuing a fresh call.",
                    None,
                    None,
                    None,
                ) from exc
            request_id = r.headers.get("x-request-id")
            if 200 <= r.status_code < 300:
                if r.status_code == 204:
                    return None
                return r.json()
            retryable = attempt < _MAX_RETRIES and (
                r.status_code == 429
                or (r.status_code >= 500 and (idempotent_method or has_idem_key))
            )
            if retryable:
                try:
                    retry_after = float(r.headers.get("retry-after", ""))
                except (TypeError, ValueError):
                    retry_after = 0.0
                wait = retry_after if retry_after > 0 else min(_RETRY_CAP, _RETRY_BASE * (2 ** attempt))
                time.sleep(wait)
                attempt += 1
                continue
            try:
                payload = r.json()
            except (ValueError, json.JSONDecodeError):
                payload = {}
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise MailsError(
                err.get("type", "api_error"),
                err.get("code", "unknown"),
                err.get("message", f"{method} {path} failed with {r.status_code}"),
                r.status_code,
                request_id,
                err.get("param"),
            )

    # --- high-level helpers ---

    def send(self, agent: Optional[str] = None, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/messages — send an email.

        ``agent`` is OPTIONAL. Omit it and the workspace's single agent is used, or one is
        created for you, named from ``from``::

            client.send(**{"from": "billing", "to": "dana@acme.com",
                           "subject": "Invoice #221", "body": "…"})

        or name it explicitly, positionally or by keyword::

            client.send("sarah", to="dana@acme.com", subject="…", body="…")

        WHY THIS IS OPTIONAL NOW. ``agent`` was a required positional here long after the API
        made it optional (2026-08-05), so the exact call our own positioning tells developers
        to write — ``{from, to, subject, body}``, no setup — raised a TypeError in Python
        before it ever reached the network, while the same call worked in TypeScript. Python
        is the language of the agent ecosystem (both the OpenAI-Agents and LangGraph examples
        are Python), so that gap fell on the users most likely to be the buyer.

        ``from`` selects the agent by handle — ``"billing"``, ``"billing@acme.com"`` and
        ``"Acme <billing@acme.com>"`` all mean the agent called ``billing``. It is resolved if
        it exists, created if it does not, and refused with 402 ``plan_limit_exceeded`` if
        your plan has no room; it is never resolved to a DIFFERENT agent. Read ``from`` on the
        result for the address that actually sent.
        """
        idempotency_key = kwargs.pop("idempotency_key", None)
        if agent is not None:
            kwargs["agent"] = agent
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", "/api/v1/messages", body, headers)

    def me(self) -> Dict[str, Any]:
        """GET /api/v1/me — who this key is: workspace, tier, scopes, mode.

        Present in the TypeScript SDK and exposed as an MCP tool; it was missing here, so a
        Python caller had no way to answer "which workspace am I talking to, and is this key
        live or test?" without a raw HTTP call.
        """
        return self._request("GET", "/api/v1/me")

    def reply(self, message_id: str, **kwargs: Any) -> Dict[str, Any]:
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        return self._request("POST", f"/api/v1/messages/{message_id}/reply", body)

    def forward(self, message_id: str, **kwargs: Any) -> Dict[str, Any]:
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        return self._request("POST", f"/api/v1/messages/{message_id}/forward", body)

    def list_threads(self, **opts: Any) -> Dict[str, Any]:
        qs = "?" + urlencode({k: v for k, v in opts.items() if v is not None}) if opts else ""
        return self._request("GET", f"/api/v1/threads{qs}")

    def get_thread(self, thread_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/threads/{thread_id}")

    def list_received(self, **opts: Any) -> Dict[str, Any]:
        qs = "?" + urlencode({k: v for k, v in opts.items() if v is not None}) if opts else ""
        return self._request("GET", f"/api/v1/messages/received{qs}")

    def get_received(self, id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/messages/received/{id}")

    def list_agents(self, **opts: Any) -> Dict[str, Any]:
        qs = "?" + urlencode({k: v for k, v in opts.items() if v is not None}) if opts else ""
        return self._request("GET", f"/api/v1/agents{qs}")

    def create_agent(
        self,
        name: str,
        domain: Optional[str] = None,
        allowlist_domains: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        body = {"name": name}
        if domain:
            body["domain"] = domain
        if allowlist_domains:
            body["allowlist_domains"] = allowlist_domains
        return self._request("POST", "/api/v1/agents", body)

    def list_events(self, **opts: Any) -> Dict[str, Any]:
        qs = "?" + urlencode({k: v for k, v in opts.items() if v is not None}) if opts else ""
        return self._request("GET", f"/api/v1/events{qs}")

    def get_event(self, event_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/events/{event_id}")

    def get_reputation(self, agent_id: Optional[str] = None) -> Dict[str, Any]:
        qs = "?" + urlencode({"agent_id": agent_id}) if agent_id else ""
        return self._request("GET", f"/api/v1/reputation{qs}")

    def check_suppression(self, address: str) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/suppression?" + urlencode({"address": address}))

    def allow_address(self, address: str, attestation: str) -> Dict[str, Any]:
        return self._request("POST", "/api/v1/suppression/allow", {"address": address, "attestation": attestation})

    def create_draft(self, **kwargs: Any) -> Dict[str, Any]:
        body = {k: v for k, v in kwargs.items() if v is not None}
        return self._request("POST", "/api/v1/drafts", body)

    def send_draft(self, draft_id: str, send_at: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if send_at is not None:
            body["send_at"] = send_at
        return self._request("POST", f"/api/v1/drafts/{draft_id}/send", body)

    def usage(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/billing/usage")

    def stream_events(
        self,
        event_types: Optional[List[str]] = None,
        since: Optional[str] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        """Blocking SSE consumer. Pass stop_event to break the loop from another thread."""
        httpx_mod = _require_httpx()
        params: Dict[str, str] = {}
        if event_types:
            params["event_types"] = ",".join(event_types)
        if since:
            params["since"] = since
        qs = ("?" + urlencode(params)) if params else ""
        url = f"{self.base_url}/api/v1/events/stream{qs}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "text/event-stream",
            "User-Agent": f"mailsai-python/{__version__}",
        }
        try:
            with httpx_mod.stream("GET", url, headers=headers, timeout=None) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if stop_event is not None and stop_event.is_set():
                        return
                    if not line or not line.startswith("data: "):
                        continue
                    try:
                        evt = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    if on_event is not None:
                        on_event(evt)
        except Exception as e:  # noqa: BLE001
            if on_error is not None:
                on_error(e)
            else:
                raise


class Agent:
    """A named agent. Pass an existing Client or omit to auto-construct from env."""

    def __init__(self, client: Client, name: str, domain: Optional[str] = None):
        self._client = client
        self.name = name
        self._domain = domain
        self._reply_handlers: List[Callable[[Dict[str, Any]], None]] = []
        self._id: Optional[str] = None
        self._stop_event: Optional[threading.Event] = None

    @property
    def client(self) -> Client:
        return self._client

    def send(
        self,
        to: Union[str, List[str]],
        subject: str,
        body: Optional[str] = None,
        body_text: Optional[str] = None,
        body_html: Optional[str] = None,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
        in_reply_to_message_id: Optional[str] = None,
        scheduled_at: Optional[str] = None,
        tags: Optional[List[Dict[str, str]]] = None,
        metadata: Optional[Dict[str, str]] = None,
        pool_hint: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._client.send(
            self.name,
            to=to,
            subject=subject,
            body_text=body_text or body,
            body_html=body_html,
            cc=cc,
            bcc=bcc,
            reply_to=reply_to,
            in_reply_to_message_id=in_reply_to_message_id,
            scheduled_at=scheduled_at,
            tags=tags,
            metadata=metadata,
            pool_hint=pool_hint,
            idempotency_key=idempotency_key,
        )

    def on_reply(self, handler: Callable[[Dict[str, Any]], None]) -> Callable[[Dict[str, Any]], None]:
        """Decorator. Register a callback for reply.received events for this agent.

        Call agent.start_listening() to begin SSE consumption.
        """
        self._reply_handlers.append(handler)
        return handler

    def list_replies(self, limit: int = 10, since: Optional[str] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"event_type": "reply.received", "agent_id": self.name, "limit": limit}
        if since is not None:
            params["since"] = since
        return self._client.list_events(**params)

    def reputation(self) -> Dict[str, Any]:
        return self._client.get_reputation(agent_id=self.name)

    def _resolve_id(self) -> str:
        if self._id is not None:
            return self._id
        rows = self._client.list_agents(limit=100)
        for row in rows.get("data", []):
            if row.get("name") == self.name:
                self._id = row["id"]
                return self._id
        raise MailsError(
            "resource_error",
            "agent_not_found",
            f'Agent "{self.name}" not found. Create it with client.create_agent("{self.name}") first.',
        )

    def start_listening(self, blocking: bool = True) -> Optional[threading.Thread]:
        """Begin consuming reply.received events and dispatch to @on_reply handlers.

        blocking=True (default) blocks the calling thread. blocking=False spawns a
        daemon thread; returns the thread for caller to join().
        """
        if not self._reply_handlers:
            raise RuntimeError("No reply handlers registered. Use @agent.on_reply first.")
        if self._stop_event is None:
            self._stop_event = threading.Event()

        def _loop() -> None:
            try:
                agent_id = self._resolve_id()
            except Exception as e:  # noqa: BLE001
                for h in self._reply_handlers:
                    print(f"[mailsai] resolve_id failed: {e}", file=sys.stderr)
                return

            def _on_event(evt: Dict[str, Any]) -> None:
                if evt.get("agent_id") != agent_id:
                    return
                for h in self._reply_handlers:
                    try:
                        h(evt)
                    except Exception as exc:  # noqa: BLE001
                        print(f"[mailsai] handler error: {exc}", file=sys.stderr)

            def _on_error(e: Exception) -> None:
                print(f"[mailsai] stream error: {e}", file=sys.stderr)

            self._client.stream_events(
                event_types=["reply.received"],
                on_event=_on_event,
                on_error=_on_error,
                stop_event=self._stop_event,
            )

        if blocking:
            _loop()
            return None
        t = threading.Thread(target=_loop, daemon=True, name=f"mailsai-stream-{self.name}")
        t.start()
        return t

    def stop_listening(self) -> None:
        if self._stop_event is not None:
            self._stop_event.set()


def create_client(api_key: Optional[str] = None, base_url: Optional[str] = None) -> Client:
    """Return a low-level Client. Use this when you need full API access."""
    return Client(api_key=api_key, base_url=base_url)


def agent(
    name: str,
    domain: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Agent:
    """Create an Agent. Reuses one Client per call; pass api_key or set MAILS_API_KEY."""
    return Agent(Client(api_key=api_key, base_url=base_url), name, domain)


def verify_webhook(
    body: str,
    signature: str,
    secret: str,
    tolerance_sec: int = 300,
) -> Optional[Dict[str, Any]]:
    """Verify a webhook signature header (Stripe-style t=<ts>,v1=<hex>).

    Returns the parsed event dict if valid, None if invalid (expired, bad MAC,
    or malformed). Use this in your webhook handler before trusting the body.
    """
    try:
        parts = dict(p.split("=", 1) for p in signature.split(",") if "=" in p)
        ts = int(parts.get("t", "0"))
        if abs(int(time.time()) - ts) > tolerance_sec:
            return None
        expected = hmac.new(
            secret.encode(),
            f"{ts}.{body}".encode(),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, parts.get("v1", "")):
            return None
        return json.loads(body)
    except (ValueError, KeyError, json.JSONDecodeError):
        return None
