"""Public deployment boundary: signed browser sessions, ownership, quotas and headers."""

import hashlib
import hmac
import json
import math
import re
import secrets
import shutil
import threading
import time
from collections import OrderedDict, deque
from http.cookies import CookieError, SimpleCookie
from urllib.parse import urlsplit
from uuid import UUID

from starlette.responses import JSONResponse

from app.access import visitor

COOKIE = "__Host-simtrm_session"
SESSION_TTL = 30 * 86400
MAX_BODY = 65536


def session_owner(cookie: str, secret: str, now: int) -> str | None:
    if not re.fullmatch(r"[0-9a-f]{32}\.[0-9]{10}\.[0-9a-f]{64}", cookie):
        return None
    owner, issued, signature = cookie.split(".")
    expected = hmac.new(secret.encode(), f"{owner}.{issued}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected) or not now - SESSION_TTL <= int(issued) <= now:
        return None
    return owner


def signed_session(owner: str, secret: str, now: int) -> str:
    payload = f"{owner}.{now}"
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def uuid_string(value) -> str | None:
    try:
        return str(UUID(value)) if isinstance(value, str) else None
    except ValueError:
        return None


class Quotas:
    def __init__(self, settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.requests = deque()
        self.jobs = deque()
        self.visitors = OrderedDict()

    @staticmethod
    def prune(values, cutoff):
        while values and values[0] <= cutoff:
            values.popleft()

    def admit(self, owner: str, *, job: bool = False) -> int:
        now = time.monotonic()
        with self.lock:
            if owner not in self.visitors:
                if len(self.visitors) >= 4096:
                    self.visitors.popitem(last=False)
                self.visitors[owner] = (deque(), deque())
            self.visitors.move_to_end(owner)
            reads, jobs = self.visitors[owner]
            window = 3600 if job else 60
            checks = (
                ((self.jobs, self.settings.public_global_jobs_per_hour),
                 (jobs, self.settings.public_jobs_per_hour))
                if job else ((self.requests, 600),
                             (reads, self.settings.public_requests_per_minute))
            )
            for queue, limit in checks:
                self.prune(queue, now - window)
                if len(queue) >= limit:
                    return max(1, math.ceil(queue[0] + window - now))
            for queue, _ in checks:
                queue.append(now)
        return 0


class PublicAccessMiddleware:
    def __init__(self, app, *, settings, db):
        self.app, self.settings, self.db = app, settings, db
        self.secret = settings.session_secret.get_secret_value()
        self.origin = settings.public_origin
        self.host = urlsplit(self.origin).hostname
        self.quotas = Quotas(settings)

    def owns(self, owner, ids):
        with self.db.connect() as connection:
            return all(connection.execute(
                "SELECT 1 FROM experiment_owners WHERE experiment_id=? AND visitor=?",
                (id, owner),
            ).fetchone() for id in ids)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope["method"]
        headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
        now, new_cookie = int(time.time()), None
        try:
            cookie = SimpleCookie(headers.get("cookie", "")).get(COOKIE)
            owner = session_owner(cookie.value if cookie else "", self.secret, now)
        except CookieError:
            owner = None
        if owner is None:
            owner = secrets.token_hex(16)
            new_cookie = signed_session(owner, self.secret, now)

        async def secure_send(message):
            if message["type"] == "http.response.start":
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"same-origin"),
                    (b"strict-transport-security", b"max-age=31536000"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"content-security-policy", (
                        b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                        b"img-src 'self' data: blob:; font-src 'self' data:; "
                        b"connect-src 'self'; worker-src 'self' blob:; "
                        b"object-src 'none'; base-uri 'self'; frame-ancestors 'none'; "
                        b"form-action 'self'"
                    )),
                ]
                existing = [(k, v) for k, v in message.get("headers", [])
                            if k.lower() not in {b"cache-control"}]
                cache = b"public, max-age=31536000, immutable" if path.startswith("/assets/") \
                    else b"no-store" if path.startswith("/api/") else b"no-cache"
                extra.append((b"cache-control", cache))
                if new_cookie and path.startswith("/api/") and path != "/api/v1/health":
                    extra.append((b"set-cookie", (
                        f"{COOKIE}={new_cookie}; Path=/; Max-Age={SESSION_TTL}; "
                        "HttpOnly; Secure; SameSite=Lax"
                    ).encode()))
                message = {**message, "headers": existing + extra}
            await send(message)

        async def reject(code, message, retry=0):
            response = JSONResponse(
                {"error": {"code": code, "message": message}}, status_code=code,
                headers={"Retry-After": str(retry)} if retry else None,
            )
            await response(scope, receive, secure_send)

        host = urlsplit("//" + headers.get("host", "")).hostname
        if host not in {self.host, "healthcheck.railway.app"}:
            return await reject(400, "Dominio no autorizado")
        if not path.startswith("/api/") or path == "/api/v1/health":
            return await self.app(scope, receive, secure_send)
        retry = self.quotas.admit(owner)
        if retry:
            return await reject(429, "Demasiadas consultas; espere antes de reintentar", retry)
        if method not in {"GET", "HEAD", "OPTIONS"}:
            if headers.get("origin") not in {None, self.origin} or \
                    headers.get("sec-fetch-site") == "cross-site":
                return await reject(403, "Origen no autorizado")
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            return await reject(400, "Tamaño de solicitud inválido")
        if length > MAX_BODY or len(scope.get("query_string", b"")) > 4096:
            return await reject(413, "La solicitud supera el tamaño permitido")
        body = b""
        if method == "POST":
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                body += event.get("body", b"")
                if len(body) > MAX_BODY:
                    return await reject(413, "La solicitud supera el tamaño permitido")
                if not event.get("more_body"):
                    break
        ids = [id for segment in path.split("/") if (id := uuid_string(segment))]
        if path in {"/api/v1/exports/scenarios", "/api/v1/exports/simulation"}:
            try:
                data = json.loads(body)
                if isinstance(data, dict):
                    values = data.get("ids", []) if path.endswith("scenarios") \
                        else [data.get("experiment_id")]
                    if isinstance(values, list):
                        ids.extend(id for value in values if (id := uuid_string(value)))
            except (ValueError, UnicodeDecodeError):
                pass  # FastAPI returns the normal validation response.
        if ids and not self.owns(owner, ids):
            return await reject(404, "Resultado guardado no encontrado")
        calculation = method == "POST" and any(part in path for part in (
            "/simulations", "/projections", "/backtests", "/validations/rolling"
        )) and "/exports/" not in path
        if calculation or "/exports/" in path:
            retry = self.quotas.admit(owner, job=True)
            if retry:
                return await reject(
                    429, "Se alcanzó el límite de trabajos; reintente más tarde", retry
                )
        if calculation and shutil.disk_usage(self.db.path.parent).free < 128 * 1024**2:
            return await reject(507, "No hay espacio suficiente para guardar otra evaluación")

        consumed = False

        async def replay_body():
            nonlocal consumed
            if method == "POST" and not consumed:
                consumed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        token = visitor.set(owner)
        try:
            await self.app(scope, replay_body, secure_send)
        finally:
            visitor.reset(token)
