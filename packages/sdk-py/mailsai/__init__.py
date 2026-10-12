"""
Mails.ai — Email API for AI agents (Python SDK).

Quick start:

    from mailsai import agent

    sarah = agent("sarah")  # receives mail at sarah.<your-workspace>@in.mails.ai
    # Transactional mail only: a cold pitch is refused with 422 cold_email_prohibited.
    sarah.send(to="user@example.com", subject="Your password reset code",
               body="Your verification code is 481920. It expires in 10 minutes.")

    @sarah.on_reply
    def handle(event):
        # event["injection_score"]   -> 0.02   (0 to 1; missing when the message was not scanned)
        # event["quarantined"]       -> False  (True at 0.95 or more)
        # A reply is not read for intent, so:
        # event["intent"]            -> "general_reply"
        # event["sender_reputation"] -> 0.85   (0.3 when it scores as an injection attempt)
        # Hold for a person: quarantined, not scanned, or 0.5 and up (a failed scan scores 0.5).
        score = event.get("injection_score")
        if event.get("quarantined") or score is None or score >= 0.5:
            return hold(event)
        print(event.get("thread_id"), score)

    sarah.start_listening()  # blocks; runs SSE consumer
"""

from __future__ import annotations

import email.utils
import hashlib
import hmac
import json
import math
import re
import uuid
import os
import sys
import threading
import time
import warnings
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple, Union
from urllib.parse import quote, urlencode

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
    __version__ = "0.4.0"
__all__ = [
    "agent",
    "Agent",
    "Client",
    "MailsError",
    "RateLimitError",
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
# The longest a server-requested wait is ever slept, and the default. A rate limit can last an
# hour; sleeping that long inside one call looks like a hang, so a longer wait raises at once.
DEFAULT_MAX_RETRY_WAIT = 60.0
# Reconnect timing for the event stream: the wait before a reconnect starts at 1 s, doubles
# after every failure up to 30 s, and drops back to 1 s as soon as a connection opens.
_STREAM_RETRY_START = 1.0
_STREAM_RETRY_CAP = 30.0
# The server sends a keepalive comment every 2 s, so this long with no bytes means the
# connection is dead (a network that dropped without closing it) and is replaced.
_STREAM_STALL = 30.0
# How many delivered event ids a stream remembers, so one the server sends again is dropped.
_STREAM_REMEMBERED_IDS = 5000


class MailsError(Exception):
    """Raised on any non-2xx response from the Mails.ai API.

    ``retry_after_seconds`` and ``resets_at`` (ISO 8601, UTC) are set when the server said when
    the call can succeed: its Retry-After, or a 429 body's ``retry_after_seconds`` and
    ``resets_at``, e.g. on a 429 whose wait is longer than the client's ``max_retry_wait``.
    """

    def __init__(
        self,
        type: str,
        code: str,
        message: str,
        status: int = 0,
        request_id: Optional[str] = None,
        param: Optional[str] = None,
        retry_after_seconds: Optional[int] = None,
        resets_at: Optional[str] = None,
    ):
        super().__init__(message)
        self.type = type
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.param = param
        self.retry_after_seconds = retry_after_seconds
        self.resets_at = resets_at


class RateLimitError(MailsError):
    """A 429: a rate limit or cap refused the call, and the client did not wait it out, because
    the reset is more than 60 seconds away (or further than ``max_retry_wait``), waiting does not
    lift it, or the short retries ran out.

    ``resets_at`` is when the limit lets the call through again (ISO 8601, UTC); None when
    waiting never helps (a cap that only an upgrade or a deletion lifts) or the server did not
    say. ``retry_after_seconds`` is how many seconds that is.
    """


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    """Retry-After in seconds: a number of seconds or an HTTP date. None when absent or unreadable."""
    if not value or not value.strip():
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            at = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if at is None:
            return None
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        return max(0.0, (at - datetime.now(timezone.utc)).total_seconds())
    return max(0.0, seconds) if math.isfinite(seconds) else None


def _retry_plan(
    retry_after: Optional[str], limit: Optional[Dict[str, Any]], attempt: int, cap: float
) -> Tuple[Optional[float], Optional[Tuple[Optional[int], Optional[str]]]]:
    """Before retry number ``attempt`` of a 429 or retry-safe 5xx: ``(seconds, None)`` to sleep
    and retry, or ``(None, (seconds, resets_at))`` to raise now.

    The API sends Retry-After only when the true wait is 60 seconds or less. A longer limit sends
    no header, and its error body (``limit``) says when it resets (``resets_at``, or None when
    waiting never helps) and in how many seconds (``retry_after_seconds``). So a wait within
    ``cap`` is slept; a longer one, or a reset of None, raises at once; with nothing said, a
    bounded exponential backoff.
    """
    now = datetime.now(timezone.utc)
    header = _parse_retry_after(retry_after)
    if header:
        if header <= cap:
            return header, None
        seconds = int(math.ceil(header))
        resets = (limit or {}).get("resets_at") or _iso_ms(now + timedelta(seconds=seconds))
        return None, (seconds, resets)
    if limit is not None and "resets_at" in limit:
        resets_at = limit.get("resets_at")
        if resets_at is None:
            return None, (None, None)
        given = limit.get("retry_after_seconds")
        if isinstance(given, (int, float)) and not isinstance(given, bool):
            wait: Optional[float] = float(given)
        else:
            try:
                wait = max(0.0, (datetime.fromisoformat(str(resets_at).replace("Z", "+00:00")) - now).total_seconds())
            except ValueError:
                wait = None
        if wait is not None and wait > cap:
            return None, (int(math.ceil(wait)), str(resets_at))
        if wait:
            return wait, None
    return min(_RETRY_CAP, _RETRY_BASE * (2 ** attempt)), None


def _iso_ms(dt: datetime) -> str:
    """A datetime in the API's UTC form, ``2026-10-04T09:30:00.000Z``. A naive datetime is UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
        f".{dt.microsecond // 1000:03d}Z"
    )


_DATE_ONLY = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_ISO_DATE_TIME = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?$"
)


def _normalize_since(value: Any) -> str:
    """A ``since`` for list_events, sent in the form every ``created_at`` has.

    That form is the UTC instant with milliseconds (``2026-10-04T09:30:00.000Z``). Takes a
    datetime (a naive one is UTC) or an ISO 8601 string (one with no offset is UTC). A plain date
    (``2026-10-04``, or a ``date``) is sent as it is. Anything else raises MailsError before a
    request is made; the API would refuse it with the same 400 invalid_param_value.
    """

    def fail() -> MailsError:
        return MailsError(
            "invalid_request_error",
            "invalid_param_value",
            "since must be a datetime or an ISO 8601 timestamp such as 2026-10-04T09:30:00.000Z "
            f"(or a plain date, 2026-10-04); got {value!r}.",
            0,
            None,
            "since",
        )

    if isinstance(value, datetime):
        return _iso_ms(value)
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        raise fail()
    s = value.strip()
    day = _DATE_ONLY.match(s)
    if day:
        try:
            date(int(day[1]), int(day[2]), int(day[3]))
        except ValueError:
            raise fail() from None
        return s
    m = _ISO_DATE_TIME.match(s)
    if not m:
        raise fail()
    y, mo, d, h, mi, sec, frac, zone = m.groups()
    try:
        tz = timezone.utc
        if zone and zone.upper() != "Z":
            digits = zone[1:].replace(":", "")
            hours, minutes = int(digits[:2]), int(digits[2:] or 0)
            if hours > 23 or minutes > 59:
                raise ValueError(zone)
            offset = timedelta(hours=hours, minutes=minutes)
            tz = timezone(-offset if zone[0] == "-" else offset)
        ms = int((frac or "").ljust(3, "0")[:3])
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(sec or 0), ms * 1000, tzinfo=tz)
    except ValueError:
        raise fail() from None
    return _iso_ms(dt)


def _qs(params: Dict[str, Any]) -> str:
    """A query string from keyword filters.

    None is left out. Booleans go as ``true``/``false``, which is what the API reads (urlencode
    alone sends ``True``, a 400). A datetime goes as its UTC ISO 8601 form, a date as YYYY-MM-DD.
    """
    out: Dict[str, Any] = {}
    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, bool):
            out[k] = "true" if v else "false"
        elif isinstance(v, datetime):
            out[k] = _iso_ms(v)
        elif isinstance(v, date):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return ("?" + urlencode(out)) if out else ""


def _seg(value: str) -> str:
    """One path segment (an id), escaped."""
    return quote(str(value), safe="")


def _from_alias(params: Dict[str, Any]) -> None:
    """``from`` is a Python keyword, so the ``from`` filter is also accepted as ``from_``."""
    if "from_" in params:
        alias = params.pop("from_")
        if params.get("from") is None:
            params["from"] = alias


def _require_httpx() -> Any:
    if httpx is None:
        raise RuntimeError(
            "The mailsai Python SDK needs httpx, which pip installs with mailsai. "
            "Install it with: pip install httpx"
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
        max_retry_wait: float = DEFAULT_MAX_RETRY_WAIT,
    ):
        """``max_retry_wait`` is the longest the client sleeps on its own before retrying a 429
        or retry-safe 5xx, in seconds: 60 by default and at most 60 (a larger value counts as
        60). A shorter wait the server asks for is slept and the call retried. A longer one, or a
        limit that waiting does not lift, raises at once: a RateLimitError for a 429, carrying
        when the limit resets (``resets_at``) and how long that is (``retry_after_seconds``)."""
        self.api_key = api_key or os.environ.get("MAILS_API_KEY") or ""
        self.base_url = (base_url or os.environ.get("MAILS_BASE_URL") or DEFAULT_BASE).rstrip("/")
        self.timeout = timeout
        self.max_retry_wait = (
            min(float(max_retry_wait), DEFAULT_MAX_RETRY_WAIT)
            if isinstance(max_retry_wait, (int, float)) and not isinstance(max_retry_wait, bool) and max_retry_wait >= 0
            else DEFAULT_MAX_RETRY_WAIT
        )
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
        idempotent: bool = False,
        timeout: Optional[float] = None,
    ) -> Any:
        r = self._send(method, path, body, headers, idempotent, timeout)
        if r.status_code == 204:
            return None
        return r.json()

    def _send(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
        idempotent: bool = False,
        timeout: Optional[float] = None,
    ) -> Any:
        """One API call with the retry policy: the successful httpx response, or MailsError.

        ``idempotent`` marks the five sends whose routes read an Idempotency-Key (send,
        batch_send, reply, forward and send_draft). ``timeout`` replaces the client's for this
        call only (wait_for_received holds a request open for up to 50 seconds)."""
        httpx_mod = _require_httpx()
        url = f"{self.base_url}{path}"
        merged_headers = self._headers(headers)
        data = json.dumps(body).encode() if body is not None else None
        # Retry-safe when a resend can't double-apply: a 429 was rejected (never
        # processed); 5xx and a lost connection only for read methods, or for a send, whose
        # Idempotency-Key makes a resend a server-side no-op.
        resend_safe = method in ("GET", "HEAD") or idempotent
        # A send that reaches the server may be PROCESSED even if we never see the
        # response (timeout, dropped connection). Without an Idempotency-Key the caller's
        # natural reaction — retry — sends the email twice. Generate one so a resend is a
        # server-side no-op. Callers who pass their own key keep full control. Any other
        # POST gets no key and is sent once: its route does not read the key, so a resend
        # would act twice (a second webhook, a second API key).
        if idempotent and not any(k.lower() == "idempotency-key" for k in merged_headers):
            merged_headers["Idempotency-Key"] = f"sdk-{uuid.uuid4()}"

        attempt = 0
        while True:
            try:
                r = httpx_mod.request(
                    method, url, headers=merged_headers, content=data, timeout=timeout or self.timeout
                )
            except Exception as exc:  # httpx.TimeoutException, ConnectError, …
                # Never leak a raw httpx traceback: callers catch MailsError, and a bare
                # transport exception carries no request id and no guidance on whether the
                # call landed. Retry only when a resend cannot double-apply.
                if attempt < _MAX_RETRIES and resend_safe:
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
                return r
            try:
                payload = r.json()
            except (ValueError, json.JSONDecodeError):
                payload = {}
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            if not isinstance(err, dict):
                err = {}
            limited = r.status_code == 429
            limit = err if limited else None
            retryable = attempt < _MAX_RETRIES and (
                limited or (r.status_code >= 500 and resend_safe)
            )
            stop: Optional[Tuple[Optional[int], Optional[str]]] = None
            if retryable:
                wait, stop = _retry_plan(r.headers.get("retry-after"), limit, attempt, self.max_retry_wait)
                if wait is not None:
                    time.sleep(wait)
                    attempt += 1
                    continue
            if stop is not None:
                waited: Optional[float] = stop[0]
            else:
                waited = _parse_retry_after(r.headers.get("retry-after"))
                if waited is None and limit is not None and isinstance(limit.get("retry_after_seconds"), (int, float)):
                    waited = float(limit["retry_after_seconds"])
            retry_after_seconds = None if waited is None else int(math.ceil(waited))
            if stop is not None:
                resets_at: Optional[str] = stop[1]
            elif limit is not None and "resets_at" in limit:
                resets_at = limit.get("resets_at")
            else:
                resets_at = (
                    None
                    if retry_after_seconds is None
                    else _iso_ms(datetime.now(timezone.utc) + timedelta(seconds=retry_after_seconds))
                )
            message = err.get("message", f"{method} {path} failed with {r.status_code}")
            if stop is not None and stop[0] is not None:
                message += (
                    f" It resets in {stop[0]} s (at {resets_at}): longer than this client waits on its"
                    f" own ({self.max_retry_wait:g} s)."
                )
            args = (
                err.get("type", "rate_limit_error" if limited else "api_error"),
                err.get("code", "unknown"),
                message,
                r.status_code,
                request_id,
                err.get("param"),
            )
            if limited:
                raise RateLimitError(*args, retry_after_seconds=retry_after_seconds, resets_at=resets_at)
            raise MailsError(*args, retry_after_seconds=retry_after_seconds, resets_at=resets_at)

    # --- high-level helpers ---

    def send(self, agent: Optional[str] = None, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/messages — send an email.

        ``agent`` is OPTIONAL. Omit it and the workspace's single agent is used, or, with a key
        that holds ``manage``, one is created for you, named from ``from``::

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
        it exists, created if it does not and the key holds ``manage`` (403
        ``insufficient_scope`` if it does not), and refused with 402 ``plan_limit_exceeded`` if
        your plan has no room; it is never resolved to a DIFFERENT agent. Read ``from`` on the
        result for the address that actually sent. Beside an explicit ``agent`` it selects
        nothing: ``agent`` decides the sender, and no agent is created from ``from``.

        ``from`` cannot spoof a sender: the From address is always the agent's own. A display
        name in it (``Acme`` in ``"Acme <billing@acme.com>"``) does go on the From line, beside
        an ``agent`` too, and on a scheduled send as well.

        The result's ``status`` is ``sent``, ``scheduled`` (a future ``scheduled_at``), or
        ``delivered`` when delivery to every recipient was confirmed at once (with a live key, a
        send only to the test address reply@test.mails.ai always is; a test key's sends answer
        ``sent``). reply() and forward() answer the same way, and so does each item of
        batch_send() that was sent. A send that fails raises instead (a failed batch item
        carries its own ``error``).

        When the email service takes the message but refuses some recipients, the send does not
        raise: it went to everyone else, and ``refused_recipients`` lists the ones it did not
        reach (present only when there were any). Sending it again with the same
        ``idempotency_key`` gives that answer back and sends nothing, so reach them with a new
        message. When every recipient is refused, nothing is sent and the send raises.

        ``attachments`` is a list of up to 10 files, 25 MB in all. Each is a dict with
        ``filename`` and either ``content_base64`` (the bytes, base64) with ``content_type``, or
        ``path``: an https URL that mails.ai downloads when it sends (``content_type`` is then
        optional; the type the URL answers with is used). Bytes travel inside the request, so
        together they can come to about 3 MB: give a larger file by ``path``. A ``path`` must
        answer within 10 seconds, after at most 3 redirects, each to https, and never at a
        private, loopback or link-local address; one that cannot be fetched raises MailsError (400
        ``invalid_field``, ``param`` ``attachments.0.path``). A file with ``content_id`` is shown
        inside the HTML instead of attached::

            client.send(to="dana@acme.com", subject="Your report",
                        body_html='<img src="cid:chart"> Here is this week.',
                        attachments=[{"filename": "chart.png", "content_id": "chart",
                                      "path": "https://files.example.com/chart.png"}])
        """
        idempotency_key = kwargs.pop("idempotency_key", None)
        if agent is not None:
            kwargs["agent"] = agent
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", "/api/v1/messages", body, headers, idempotent=True)

    def me(self) -> Dict[str, Any]:
        """GET /api/v1/me — who this key is: workspace, tier, scopes, mode.

        Present in the TypeScript SDK and exposed as an MCP tool; it was missing here, so a
        Python caller had no way to answer "which workspace am I talking to, and is this key
        live or test?" without a raw HTTP call.
        """
        return self._request("GET", "/api/v1/me")

    def reply(self, message_id: str, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/messages/{id}/reply. ``idempotency_key`` is sent as the Idempotency-Key
        header, as on send: a retry with the same key returns the first reply."""
        idempotency_key = kwargs.pop("idempotency_key", None)
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", f"/api/v1/messages/{_seg(message_id)}/reply", body, headers, idempotent=True)

    def forward(self, message_id: str, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/messages/{id}/forward. ``idempotency_key`` works as on reply."""
        idempotency_key = kwargs.pop("idempotency_key", None)
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", f"/api/v1/messages/{_seg(message_id)}/forward", body, headers, idempotent=True)

    # --- messages ---

    def list_messages(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/messages — sent mail, newest first. Filters: limit, cursor, agent_id,
        thread_id, q (a substring of the subject, body or recipients)."""
        return self._request("GET", f"/api/v1/messages{_qs(opts)}")

    def batch_send(self, messages: List[Dict[str, Any]], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/v1/messages/batch — up to 100 sends in one call, each shaped like send()'s
        keyword arguments (``agent`` optional, ``from`` and ``references`` honoured, as on send())
        but with no ``attachments``: the API refuses a batch that carries files (422), so send
        those on their own. Each one succeeds or fails on its own."""
        items = []
        for m in messages:
            item = dict(m)
            _fold_body(item)
            items.append({k: v for k, v in item.items() if v is not None})
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", "/api/v1/messages/batch", items, headers, idempotent=True)

    def appeal(self, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/messages/appeal — a second, independent review of content refused with
        ``cold_email_prohibited``. Pass the SAME ``subject`` and ``body`` (or body_text /
        body_html) the refused send used, and its ``agent`` if the workspace has several.
        ``outcome`` is ``overturned`` (that exact content is cleared for 24 hours), ``upheld``,
        ``not_appealable`` or ``not_blocked``."""
        _fold_body(kwargs)
        body = {k: v for k, v in kwargs.items() if v is not None}
        return self._request("POST", "/api/v1/messages/appeal", body)

    def get_message(self, message_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/messages/{_seg(message_id)}")

    def reschedule_message(self, message_id: str, scheduled_at: Union[str, datetime]) -> Dict[str, Any]:
        """PATCH /api/v1/messages/{id} — move a scheduled send. A datetime is sent in UTC."""
        when = _iso_ms(scheduled_at) if isinstance(scheduled_at, datetime) else scheduled_at
        return self._request("PATCH", f"/api/v1/messages/{_seg(message_id)}", {"scheduled_at": when})

    def cancel_message(self, message_id: str) -> Dict[str, Any]:
        """POST /api/v1/messages/{id}/cancel — cancel a scheduled send."""
        return self._request("POST", f"/api/v1/messages/{_seg(message_id)}/cancel")

    def get_raw_message(self, message_id: str) -> str:
        """GET /api/v1/messages/{id}/raw — the sent message as an RFC 822 (.eml) string."""
        return self._send("GET", f"/api/v1/messages/{_seg(message_id)}/raw").text

    # --- threads ---

    def list_threads(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/threads. Filters: limit, cursor, agent_id, status, folder (one folder, or
        ``all``; without it every folder except trash), read (True/False), label, q, and mode
        (``live``, ``test`` or ``all``; without it, the threads of the key's own mode). Each
        thread's ``test_mode`` is True when it holds no live mail."""
        return self._request("GET", f"/api/v1/threads{_qs(opts)}")

    def get_thread(self, thread_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/threads/{_seg(thread_id)}")

    def update_thread(self, thread_id: str, **patch: Any) -> Dict[str, Any]:
        """PATCH /api/v1/threads/{id}. Fields: labels or label_ids (replace the labels), status,
        read, folder (``trash`` deletes it; ``inbox`` restores it)."""
        return self._request("PATCH", f"/api/v1/threads/{_seg(thread_id)}", patch)

    def delete_thread(self, thread_id: str, permanent: bool = False) -> Dict[str, Any]:
        """DELETE /api/v1/threads/{id}. Moves the thread to trash (``deleted`` False; restore it
        with update_thread(folder="inbox")), or with ``permanent=True`` deletes it for good."""
        qs = "?permanent=true" if permanent else ""
        return self._request("DELETE", f"/api/v1/threads/{_seg(thread_id)}{qs}")

    # --- labels ---

    def list_labels(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/labels")

    def create_label(self, name: str, color: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/v1/labels. ``name`` is unique in the workspace, ignoring case; ``color``
        (gray, red, orange, amber, yellow, green, teal, cyan, blue, indigo, purple, pink)
        defaults to gray."""
        body: Dict[str, Any] = {"name": name}
        if color is not None:
            body["color"] = color
        return self._request("POST", "/api/v1/labels", body)

    def get_label(self, label_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/labels/{_seg(label_id)}")

    def update_label(self, label_id: str, name: Optional[str] = None, color: Optional[str] = None) -> Dict[str, Any]:
        """PATCH /api/v1/labels/{id}. Renaming a label renames it on every thread that carries it."""
        body = {k: v for k, v in {"name": name, "color": color}.items() if v is not None}
        return self._request("PATCH", f"/api/v1/labels/{_seg(label_id)}", body)

    def delete_label(self, label_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/labels/{_seg(label_id)}")

    # --- search and metrics ---

    def search(self, q: Optional[str] = None, **filters: Any) -> Dict[str, Any]:
        """GET /api/v1/search — received and sent mail, newest first. Filters: agent_id,
        ``from_`` (or ``**{"from": …}``), to, after and before (a datetime, an ISO 8601 string
        or a plain date), has_attachment (True/False), folder, label, type (received or sent),
        limit, cursor."""
        _from_alias(filters)
        return self._request("GET", f"/api/v1/search{_qs({'q': q, **filters})}")

    def get_metrics(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/metrics — sent, delivered, bounced, complained, received and reply counts
        per day or hour. Filters: ``from_`` (or ``**{"from": …}``) and to (a datetime, an ISO 8601
        string or a plain date), agent_id, interval (day or hour)."""
        _from_alias(opts)
        return self._request("GET", f"/api/v1/metrics{_qs(opts)}")

    # --- received mail ---

    def list_received(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/messages/received. Filters: limit, cursor, agent_id, thread_id, q,
        ``from_`` (or ``**{"from": …}``: an address, or a domain and its subdomains) and since
        (a datetime or an ISO 8601 string, sent as list_events sends it). Each message carries
        ``codes`` and ``links``."""
        _from_alias(opts)
        if opts.get("since"):
            opts["since"] = _normalize_since(opts["since"])
        return self._request("GET", f"/api/v1/messages/received{_qs(opts)}")

    def wait_for_received(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/messages/received/wait — the newest received message that matches,
        waiting up to ``timeout`` seconds (0 to 50, default 30) for one to arrive. Filters:
        agent_id, ``from_`` (or ``**{"from": …}``), since (default: the last 5 minutes) and has
        (``"code"`` or ``"link"``). Returns ``{"message": …, "timed_out": …}``, ``message`` None
        when none arrived in time. A sign-up code:
        ``client.wait_for_received(from_="github.com", has="code")["message"]["codes"][0]["value"]``."""
        _from_alias(opts)
        if opts.get("since"):
            opts["since"] = _normalize_since(opts["since"])
        wait = float(opts.get("timeout") or 30)
        return self._request(
            "GET", f"/api/v1/messages/received/wait{_qs(opts)}", timeout=max(self.timeout, wait + 15)
        )

    def get_received(self, id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/messages/received/{_seg(id)}")

    def list_attachments(self, message_id: str) -> Dict[str, Any]:
        """GET /api/v1/messages/received/{id}/attachments — the files on a received message
        (``data``), and any that were not kept (``omitted``) with the reason."""
        return self._request("GET", f"/api/v1/messages/received/{_seg(message_id)}/attachments")

    def download_attachment(self, message_id: str, attachment_id: str, inline: bool = False) -> bytes:
        """GET /api/v1/messages/received/{id}/attachments/{attachment_id} — the file's bytes,
        exactly as received. ``inline=True`` only changes how a browser shows it."""
        qs = "?inline=1" if inline else ""
        path = f"/api/v1/messages/received/{_seg(message_id)}/attachments/{_seg(attachment_id)}{qs}"
        return self._send("GET", path).content

    def test_inbound(self, agent: str, **kwargs: Any) -> Dict[str, Any]:
        """POST /api/v1/test/inbound — simulate an inbound email to one of your agents (TEST key
        only). Fields: ``from_`` (or ``**{"from": …}``), from_name, subject, body_text,
        raw_base64, in_reply_to_message_id, spf, dkim."""
        _from_alias(kwargs)
        body = {"agent": agent, **{k: v for k, v in kwargs.items() if v is not None}}
        return self._request("POST", "/api/v1/test/inbound", body)

    # --- agents ---

    def list_agents(self, **opts: Any) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/agents{_qs(opts)}")

    def create_agent(
        self,
        name: Optional[str] = None,
        domain: Optional[str] = None,
        allowlist_domains: Optional[List[str]] = None,
        blocklist_domains: Optional[List[str]] = None,
        daily_send_limit: Optional[int] = None,
        hourly_send_limit: Optional[int] = None,
        classify_inbound: Optional[bool] = None,
        address: Optional[str] = None,
        forwarding: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/agents. `name` for an agent on the workspace's mails.ai address, or
        `address` for one at an address on a domain the workspace has verified (named after the
        part before the @), with `forwarding=True` when the mail service that already hosts it
        forwards its mail to the agent's forwarding_address."""
        body: Dict[str, Any] = {}
        if name:
            body["name"] = name
        if domain:
            body["domain"] = domain
        if allowlist_domains:
            body["allowlist_domains"] = allowlist_domains
        extra = {
            "blocklist_domains": blocklist_domains,
            "daily_send_limit": daily_send_limit,
            "hourly_send_limit": hourly_send_limit,
            "classify_inbound": classify_inbound,
            "address": address,
            "forwarding": forwarding,
        }
        body.update({k: v for k, v in extra.items() if v is not None})
        return self._request("POST", "/api/v1/agents", body)

    def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/agents/{_seg(agent_id)}")

    def update_agent(self, agent_id: str, **patch: Any) -> Dict[str, Any]:
        """PATCH /api/v1/agents/{id}. Fields: status (active or paused), allowlist_domains,
        blocklist_domains, daily_send_limit and hourly_send_limit (None clears), classify_inbound,
        forwarding (turning it on or off starts the forwarding test again)."""
        return self._request("PATCH", f"/api/v1/agents/{_seg(agent_id)}", patch)

    def verify_agent_forwarding(self, agent_id: str) -> Dict[str, Any]:
        """POST /api/v1/agents/{id}/forwarding/verify — send one test email, from mails.ai, to the
        address of an agent in forwarding mode, and get the agent back at once. Its
        forwarding_status turns verified when the test comes back through the forward, or failing
        if it is still missing 15 minutes later. Needs a live key."""
        return self._request("POST", f"/api/v1/agents/{_seg(agent_id)}/forwarding/verify")

    def archive_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/agents/{_seg(agent_id)}")

    def get_agent_inbox(self, agent_id: str) -> Dict[str, Any]:
        """GET /api/v1/agents/{id}/inbox — unread and thread counts per folder and per label."""
        return self._request("GET", f"/api/v1/agents/{_seg(agent_id)}/inbox")

    # --- events ---

    def list_events(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/events. Filters: limit, cursor, event_type, agent_id, since. ``since`` (a
        datetime or an ISO 8601 string) is sent in the form every ``created_at`` has; a value
        that is not a time raises MailsError before any request, as the API would refuse it."""
        if opts.get("since"):
            opts["since"] = _normalize_since(opts["since"])
        return self._request("GET", f"/api/v1/events{_qs(opts)}")

    def get_event(self, event_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/events/{_seg(event_id)}")

    def redeliver_event(self, event_id: str) -> Dict[str, Any]:
        """POST /api/v1/events/{id}/redeliver — send the event to your webhooks again."""
        return self._request("POST", f"/api/v1/events/{_seg(event_id)}/redeliver", {})

    # --- webhooks ---

    def list_webhooks(self, **opts: Any) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/webhooks{_qs(opts)}")

    def create_webhook(
        self, url: str, event_types: Optional[List[str]] = None, description: Optional[str] = None
    ) -> Dict[str, Any]:
        """POST /api/v1/webhooks. The answer's ``signing_secret`` is shown once."""
        body = {k: v for k, v in {"url": url, "event_types": event_types, "description": description}.items() if v is not None}
        return self._request("POST", "/api/v1/webhooks", body)

    def get_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/webhooks/{_seg(webhook_id)}")

    def update_webhook(self, webhook_id: str, **patch: Any) -> Dict[str, Any]:
        """PATCH /api/v1/webhooks/{id}. Fields: url, event_types, description, active."""
        return self._request("PATCH", f"/api/v1/webhooks/{_seg(webhook_id)}", patch)

    def delete_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/webhooks/{_seg(webhook_id)}")

    def rotate_webhook_secret(self, webhook_id: str) -> Dict[str, Any]:
        """POST /api/v1/webhooks/{id}/rotate-secret — a new signing secret, shown once. For 24
        hours every delivery is also signed with the previous one."""
        return self._request("POST", f"/api/v1/webhooks/{_seg(webhook_id)}/rotate-secret")

    def list_webhook_deliveries(self, webhook_id: str, **opts: Any) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/webhooks/{_seg(webhook_id)}/deliveries{_qs(opts)}")

    def test_webhook(self, webhook_id: str) -> Dict[str, Any]:
        """POST /api/v1/webhooks/{id}/test — send a signed test event to the endpoint now."""
        return self._request("POST", f"/api/v1/webhooks/{_seg(webhook_id)}/test")

    def replay_webhook_delivery(self, delivery_id: str) -> Dict[str, Any]:
        """POST /api/v1/webhook-deliveries/{id}/replay — deliver that delivery's event again."""
        return self._request("POST", f"/api/v1/webhook-deliveries/{_seg(delivery_id)}/replay", {})

    def get_reputation(self, agent_id: Optional[str] = None) -> Dict[str, Any]:
        qs = "?" + urlencode({"agent_id": agent_id}) if agent_id else ""
        return self._request("GET", f"/api/v1/reputation{qs}")

    # --- suppression ---

    def check_suppression(self, address: str) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/suppression?" + urlencode({"address": address}))

    def allow_address(self, address: str, attestation: str) -> Dict[str, Any]:
        return self._request("POST", "/api/v1/suppression/allow", {"address": address, "attestation": attestation})

    def list_suppression(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/suppression — the allowlist attestations, or with ``view="suppressed"``
        the workspace's recent recipients that are suppressed. Filters: view, limit, cursor."""
        return self._request("GET", f"/api/v1/suppression{_qs(opts)}")

    def revoke_allow(self, entry_id: str) -> Dict[str, Any]:
        """DELETE /api/v1/suppression/allow/{id} — withdraw an allowlist attestation."""
        return self._request("DELETE", f"/api/v1/suppression/allow/{_seg(entry_id)}")

    # --- drafts ---

    def create_draft(self, **kwargs: Any) -> Dict[str, Any]:
        body = {k: v for k, v in kwargs.items() if v is not None}
        return self._request("POST", "/api/v1/drafts", body)

    def send_draft(self, draft_id: str, send_at: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/v1/drafts/{id}/send. ``idempotency_key`` works as on reply."""
        body: Dict[str, Any] = {}
        if send_at is not None:
            body["send_at"] = send_at
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", f"/api/v1/drafts/{_seg(draft_id)}/send", body, headers, idempotent=True)

    def list_drafts(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/drafts. Filters: limit, cursor, agent_id, status."""
        return self._request("GET", f"/api/v1/drafts{_qs(opts)}")

    def get_draft(self, draft_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/drafts/{_seg(draft_id)}")

    def update_draft(self, draft_id: str, **patch: Any) -> Dict[str, Any]:
        """PATCH /api/v1/drafts/{id}. Fields: to, cc, bcc, subject, body_text, body_html,
        send_at (None unschedules), list_unsubscribe."""
        return self._request("PATCH", f"/api/v1/drafts/{_seg(draft_id)}", patch)

    def delete_draft(self, draft_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/drafts/{_seg(draft_id)}")

    # --- domains ---

    def list_domains(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/domains")

    def create_domain(self, domain: str) -> Dict[str, Any]:
        """POST /api/v1/domains — register a custom sending domain; the answer lists the DNS
        records to create."""
        return self._request("POST", "/api/v1/domains", {"domain": domain})

    def get_domain(self, domain_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/domains/{_seg(domain_id)}")

    def delete_domain(self, domain_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/domains/{_seg(domain_id)}")

    def verify_domain(self, domain_id: str) -> Dict[str, Any]:
        """POST /api/v1/domains/{id}/verify — check the domain's DNS records now."""
        return self._request("POST", f"/api/v1/domains/{_seg(domain_id)}/verify")

    # --- API keys ---

    def list_api_keys(self, **opts: Any) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/api-keys{_qs(opts)}")

    def create_api_key(
        self,
        name: Optional[str] = None,
        agent_id: Optional[str] = None,
        scopes: Optional[List[str]] = None,
        mode: Optional[str] = None,
        expires_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/api-keys. The answer's ``key`` is shown once. ``agent_id`` ties the key to
        one agent's mail; ``scopes`` are send, read, manage and draft (writes drafts but can
        neither send nor schedule one), send and read by default."""
        fields = {"name": name, "agent_id": agent_id, "scopes": scopes, "mode": mode, "expires_at": expires_at}
        return self._request("POST", "/api/v1/api-keys", {k: v for k, v in fields.items() if v is not None})

    def revoke_api_key(self, key_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/api/v1/api-keys/{_seg(key_id)}")

    # --- connected apps ---

    def list_connected_apps(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/oauth/grants: the apps connected to the workspace by signing in (the mails
        CLI, or an app such as Claude, ChatGPT or Cursor) that can still act, newest first. Needs
        an API key with ``manage`` that is not tied to an agent; a connected app is refused (403
        ``connected_app_not_allowed``)."""
        return self._request("GET", f"/api/v1/oauth/grants{_qs(opts)}")

    def revoke_connected_app(self, app_id: str) -> Dict[str, Any]:
        """DELETE /api/v1/oauth/grants/{id}: ends the app's sign-in at once. The API keys and
        webhook endpoints it created stay, and the answer counts them."""
        return self._request("DELETE", f"/api/v1/oauth/grants/{_seg(app_id)}")

    # --- account ---

    def usage(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/billing/usage")

    def open_billing_portal(
        self, return_url: Optional[str] = None, price_lookup_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """POST /api/v1/billing/portal — a Stripe billing-portal link (``url``)."""
        fields = {"return_url": return_url, "price_lookup_key": price_lookup_key}
        return self._request("POST", "/api/v1/billing/portal", {k: v for k, v in fields.items() if v is not None})

    def list_logs(self, **opts: Any) -> Dict[str, Any]:
        """GET /api/v1/logs — the workspace's audit log. Filters: limit, cursor, category, action."""
        return self._request("GET", f"/api/v1/logs{_qs(opts)}")

    def health(self) -> Dict[str, Any]:
        """GET /api/health — ``status`` (healthy or degraded) and the server's time."""
        return self._request("GET", "/api/health")

    def stream_events(
        self,
        event_types: Optional[List[str]] = None,
        since: Optional[str] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        stop_event: Optional[threading.Event] = None,
        on_position: Optional[Callable[[str], None]] = None,
    ) -> None:
        """Blocking SSE consumer that keeps going until stop_event is set (from another thread).

        The server ends each connection after about 50 seconds and a network can drop one at
        any time; this reconnects by itself from where the server said the stream was, so no
        event is missed, and one the server sends again is not handed to ``on_event`` a second
        time (see _reconnecting_event_stream). Events arrive in id order, except one whose row
        was written late: it arrives after newer ones rather than not at all.

        Without ``since`` it starts after the newest event there is when you call it (it reads
        that event's id with ``GET /v1/events?limit=1`` first): you get what happens from now
        on, and a connection that drops before the first event misses nothing either. With it
        (a position ``on_position`` gave you, or an event id, ``evt_...``), it resumes there
        first.

        ``on_position`` is given the stream's position each time it moves: a string to save and
        pass back as ``since`` when you start again. A position starts the stream exactly where
        it was, so an event written late while you were away is not missed; an event id only
        starts it after that event. It is called after the events before it were handed to
        ``on_event``. A new process remembers nothing of the last one, so keep the ids you
        handled if handling one twice would matter: delivery is at least once.

        ``event_types`` keeps only those types (exact names; ``"*"`` or an empty list means all
        of them). The SDK reads every event and filters here, so the cursor moves past events
        of other types too (see _reconnecting_event_stream).

        ``on_error`` is called for every failed connection (the stream carries on and retries)
        and for an exception raised by ``on_event``. A 401 or 403 ends the stream: the key is
        wrong or lacks the ``read`` scope, so retrying cannot help. It goes to ``on_error``, or
        is raised as MailsError when there is no ``on_error``.
        """
        _reconnecting_event_stream(self, event_types, since, on_event, on_error, stop_event, on_position)


def _reconnecting_event_stream(
    client: "Client",
    event_types: Optional[List[str]],
    since: Optional[str],
    on_event: Optional[Callable[[Dict[str, Any]], None]],
    on_error: Optional[Callable[[Exception], None]],
    stop_event: Optional[threading.Event],
    on_position: Optional[Callable[[str], None]] = None,
) -> None:
    """The event stream, kept open: one connection after another, each resuming from where the
    last one was, until stop_event is set.

    Until 2026-10-05 stream_events (and so Agent.start_listening) made ONE connection: when
    the server closed it at 50 s the call simply returned, and an agent "listening for
    replies" went deaf in under a minute.

    - Without since, the cursor starts at the newest event the key can see, read with
      GET /v1/events?limit=1 before the first connection ("0", before every id, when there is
      none yet). The server starts a connection without a cursor at its own newest event, so
      until 2026-10-05 a connection that closed before any event reconnected at "now" and
      skipped what landed in between: the very reply start_listening waits for. The CLI reads
      the cursor the same way.
    - The server says where the stream is in an SSE ``id:`` with no data, its POSITION
      (``evt_...~<n>``): when a connection opens, after every batch of events, and when a
      newer one spares the client a repeat. That is the cursor a reconnect resumes from, and
      it carries what a bare event id cannot: an event whose row is written late, with an id
      smaller than one already sent, is still sent after a reconnect. Once a connection has
      given a position, an event's own id never replaces it. (A server that sends no
      positions is resumed from the id of the last event, as before 2026-10-06.)
    - Delivery is at least once: resuming from a position can bring an event a second time.
      The last 5,000 ids handed to on_event are remembered and such an event is dropped, so
      on_event hears each event once.
    - Every event is read, whatever event_types asks for: the filter is applied here, after
      the cursor has moved. Until 2026-10-06 it went to the server, which then sends nothing
      for an event of another type, so the cursor stayed at the last matching event and every
      reconnect read the same events again. One connection reads about 1,250 (50 every 2 s for
      50 s), so a listener for one type with more than that many other events after its cursor
      never reached a new one: start_listening in a workspace that sends a few hundred emails
      between two replies went deaf, with no error.
    - Every failed connection goes to on_error, then the stream waits and tries again: 1 s,
      doubling to 30 s, back to 1 s once a connection opens. A connection the server simply
      finished is not a failure.
    - A 401 or 403 ends it: the key is wrong or lacks the read scope.
    """
    httpx_mod = _require_httpx()
    stop = stop_event if stop_event is not None else threading.Event()
    headers = {
        "Authorization": f"Bearer {client.api_key}",
        "Accept": "text/event-stream",
        "User-Agent": f"mailsai-python/{__version__}",
    }

    def report(exc: Exception) -> None:
        if on_error is None:
            return
        try:
            on_error(exc)
        except Exception:  # noqa: BLE001 — the caller's own on_error raised; nothing more to tell it
            pass

    wanted = [t.strip() for t in (event_types or []) if isinstance(t, str) and t.strip()]

    def wants(evt: Dict[str, Any]) -> bool:
        return not wanted or "*" in wanted or evt.get("type") in wanted

    cursor = since or None
    given: Optional[str] = None  # the last position handed to on_position
    delivered: "OrderedDict[str, None]" = OrderedDict()  # the ids handed to on_event, oldest first

    def first_time(event_id: Any) -> bool:
        if not isinstance(event_id, str):
            return True
        if event_id in delivered:
            return False
        delivered[event_id] = None
        if len(delivered) > _STREAM_REMEMBERED_IDS:
            delivered.popitem(last=False)  # the oldest
        return True

    delay = _STREAM_RETRY_START
    while not stop.is_set():
        failed = False
        try:
            if cursor is None:
                try:
                    page = client.list_events(limit=1)
                except MailsError as exc:
                    if exc.status in (401, 403) and on_error is not None:
                        report(exc)
                        return
                    raise
                data = page.get("data") if isinstance(page, dict) else None
                newest = data[0].get("id") if isinstance(data, list) and data and isinstance(data[0], dict) else None
                cursor = newest if isinstance(newest, str) and newest else "0"
            # No event_types in the request: the filter is wants(), above.
            url = f"{client.base_url}/api/v1/events/stream?{urlencode({'since': cursor})}"
            # read= is the longest wait for the next chunk; the keepalives arrive every 2 s.
            with httpx_mod.stream("GET", url, headers=headers, timeout=httpx_mod.Timeout(_STREAM_STALL)) as r:
                if r.status_code in (401, 403):
                    r.read()
                    try:
                        err = (r.json() or {}).get("error", {})
                    except (ValueError, json.JSONDecodeError):
                        err = {}
                    refused = MailsError(
                        err.get("type", "authentication_error" if r.status_code == 401 else "permission_error"),
                        err.get("code", "invalid_api_key" if r.status_code == 401 else "insufficient_scope"),
                        err.get("message", f"event stream refused with HTTP {r.status_code}"),
                        r.status_code,
                        r.headers.get("x-request-id"),
                    )
                    if on_error is None:
                        raise refused
                    report(refused)
                    return
                if r.status_code != 200:
                    raise MailsError(
                        "api_error",
                        "stream_error",
                        f"event stream answered HTTP {r.status_code}",
                        r.status_code,
                        r.headers.get("x-request-id"),
                    )
                delay = _STREAM_RETRY_START  # connected: the next wait starts from 1 s again

                # Server-sent events: fields up to a blank line make one event; lines starting
                # with ":" are comments (the keepalives). httpx yields lines without endings.
                event_id: Optional[str] = None
                id_in_block = False
                positioned = False  # this connection has said where the stream is
                data: List[str] = []
                for line in r.iter_lines():
                    if stop.is_set():
                        return
                    if line == "":
                        if data:
                            try:
                                evt = json.loads("\n".join(data))
                            except json.JSONDecodeError:
                                evt = None
                            if isinstance(evt, dict):
                                eid = event_id or evt.get("id")
                                if eid and not positioned:
                                    cursor = eid
                                if on_event is not None and first_time(evt.get("id")):
                                    # An event of another type stops here, after the cursor has
                                    # moved past it (see above), as in the TypeScript SDK.
                                    if wants(evt):
                                        try:
                                            on_event(evt)
                                        except Exception as exc:  # noqa: BLE001
                                            report(exc)
                        elif id_in_block and event_id:
                            # An id with no data: the stream's position.
                            positioned = True
                            cursor = event_id
                            if on_position is not None and event_id != given:
                                given = event_id
                                try:
                                    on_position(event_id)
                                except Exception as exc:  # noqa: BLE001
                                    report(exc)
                        data = []
                        id_in_block = False
                        continue
                    if line.startswith(":"):
                        continue
                    field, _, value = line.partition(":")
                    if value.startswith(" "):
                        value = value[1:]
                    if field == "data":
                        data.append(value)
                    elif field == "id" and "\x00" not in value:
                        event_id = value
                        id_in_block = True
        except MailsError as exc:
            if exc.status in (401, 403):
                raise
            if stop.is_set():
                return
            failed = True
            report(exc)
        except Exception as exc:  # noqa: BLE001 — httpx.TransportError, ReadTimeout, a dropped body
            if stop.is_set():
                return
            failed = True
            report(exc)
        if stop.wait(delay):
            return
        if failed:
            delay = min(delay * 2, _STREAM_RETRY_CAP)


class Agent:
    """An agent, by its name or its id (``agt_...``), on an existing Client.

    When two agents share a name (one at ``<workspace>.mails.ai`` and one on your own domain),
    a key tied to one of them means that one. A workspace key sends from the older one, and
    its reads and listeners are refused with 409 ``agent_name_conflict``: pass the id as
    ``name``. ``domain`` does not pick between them: it is accepted so older code keeps
    running, and is not used.
    """

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
        list_unsubscribe: Optional[bool] = None,
        attachments: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Send as this agent.

        ``attachments`` takes the same files as Client.send: each by its bytes
        (``content_base64`` and ``content_type``) or by an https ``path`` that mails.ai fetches
        when it sends, and shown inside the HTML when it has a ``content_id``.

        ``list_unsubscribe=True`` opts in to RFC 8058 one-click unsubscribe headers, so the
        recipient's mail app shows an Unsubscribe button. One click suppresses the address
        for your whole workspace (later sends are refused with ``recipient_suppressed``), so
        use it for newsletters and digests and leave it off (the default) for password
        resets, sign-in links and receipts. It needs exactly one ``to`` and no cc or bcc.

        ``pool_hint`` is deprecated: the API ignores it and decides how each message is sent.
        Passing it issues a DeprecationWarning; it stays so code that passes it keeps running.
        """
        if pool_hint is not None:
            warnings.warn(
                "pool_hint is deprecated: the API ignores it and decides how each message is sent.",
                DeprecationWarning,
                stacklevel=2,
            )
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
            list_unsubscribe=list_unsubscribe,
            attachments=attachments,
        )

    def on_reply(self, handler: Callable[[Dict[str, Any]], None]) -> Callable[[Dict[str, Any]], None]:
        """Decorator. Register a callback for reply.received events for this agent.

        Call agent.start_listening() to begin SSE consumption.
        """
        self._reply_handlers.append(handler)
        return handler

    def list_replies(self, limit: int = 10, since: Optional[Union[str, datetime, date]] = None) -> Dict[str, Any]:
        """Recent replies to this agent. ``since`` takes a datetime or an ISO 8601 string, as on
        Client.list_events."""
        params: Dict[str, Any] = {"event_type": "reply.received", "agent_id": self.name, "limit": limit}
        if since is not None:
            params["since"] = since
        return self._client.list_events(**params)

    def reputation(self) -> Dict[str, Any]:
        return self._client.get_reputation(agent_id=self.name)

    def _resolve_id(self) -> str:
        if self._id is not None:
            return self._id
        # Through the route that resolves a name as every other call does. Until 2026-10-06
        # this read the first 100 agents and took the first with the name: an agent past the
        # first page was "not found", and of two agents sharing a name (one on a custom domain)
        # the first listed won, where the API answers 409.
        try:
            row = self._client.get_agent(self.name)
        except MailsError as exc:
            if exc.code == "agent_not_found":
                raise MailsError(
                    "resource_error",
                    "agent_not_found",
                    f'Agent "{self.name}" not found. Create it with client.create_agent("{self.name}") first.',
                    exc.status,
                    exc.request_id,
                ) from None
            raise
        self._id = row["id"]
        return self._id

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
                # Once, however many handlers there are (it was once per handler).
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


def create_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
    max_retry_wait: float = DEFAULT_MAX_RETRY_WAIT,
) -> Client:
    """Return a low-level Client. Use this when you need full API access."""
    return Client(api_key=api_key, base_url=base_url, timeout=timeout, max_retry_wait=max_retry_wait)


def agent(
    name: str,
    domain: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Agent:
    """An Agent on a new Client; pass api_key or set MAILS_API_KEY. ``name`` is the agent's
    name or its id (``agt_...``). ``domain`` is not used (see Agent)."""
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
    The header carries one v1 per signing secret in force (two for 24 hours
    after a secret rotation), so a match against any of them verifies. Hex is
    compared without regard to case, as the server and the TypeScript SDK do.
    """
    try:
        pairs = [p.split("=", 1) for p in signature.split(",") if "=" in p]
        ts = int(next((v.strip() for k, v in pairs if k.strip() == "t"), "0"))
        if abs(int(time.time()) - ts) > tolerance_sec:
            return None
        expected = hmac.new(
            secret.encode(),
            f"{ts}.{body}".encode(),
            hashlib.sha256,
        ).hexdigest()
        if not any(
            hmac.compare_digest(expected, v.strip().lower()) for k, v in pairs if k.strip() == "v1"
        ):
            return None
        return json.loads(body)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None
