from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, ConfigDict, Field

from catalog import SchoolCatalog
from easistent import AppError, EasistentService, parse_public_timetable_url


logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=ROOT / "templates")
BODY_LIMIT = 8 * 1024
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"
FORWARDED_PREFIX = re.compile(r"^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$")


class TimetableBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timetableUrl: str = Field(min_length=1, max_length=500)


class AvailabilityBody(TimetableBody):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    period: int = Field(ge=-1, le=30)


class SearchCapacity:
    def __init__(self, maximum: int = 25) -> None:
        self.maximum = maximum
        self.active = 0
        self._lock = asyncio.Lock()

    async def acquire(self) -> bool:
        async with self._lock:
            if self.active >= self.maximum:
                return False
            self.active += 1
            return True

    async def release(self) -> None:
        async with self._lock:
            self.active = max(0, self.active - 1)


class InMemoryRateLimiter:
    def __init__(self, maximum: int = 30, window_seconds: float = 60.0) -> None:
        self.maximum = maximum
        self.window_seconds = window_seconds
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def allow(self, key: str) -> bool:
        now = time.monotonic()
        async with self._lock:
            requests = self._requests[key]
            while requests and requests[0] <= now - self.window_seconds:
                requests.popleft()
            if len(requests) >= self.maximum:
                return False
            requests.append(now)
            return True


class BodyLimitMiddleware:
    def __init__(self, app: Callable[..., Awaitable[None]], limit: int = BODY_LIMIT) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[dict[str, Any]]], send: Callable[..., Awaitable[None]]) -> None:
        if scope["type"] != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > self.limit:
            await self._reject(send)
            return
        messages: list[dict[str, Any]] = []
        total = 0
        more = True
        while more:
            message = await receive()
            messages.append(message)
            if message.get("type") == "http.request":
                total += len(message.get("body", b""))
                more = bool(message.get("more_body", False))
                if total > self.limit:
                    await self._reject(send)
                    return
            else:
                more = False

        async def replay() -> dict[str, Any]:
            return messages.pop(0) if messages else {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send: Callable[..., Awaitable[None]]) -> None:
        body = json.dumps({
            "v": 1,
            "error": {"code": "INVALID_REQUEST", "message": "Zahteva je prevelika."},
        }, separators=(",", ":")).encode()
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})


def create_app(
    *,
    service: EasistentService | None = None,
    catalog: SchoolCatalog | None = None,
    testing: bool = False,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        parser_executor: ThreadPoolExecutor | None = None
        client: httpx.AsyncClient | None = None
        if service is None:
            parser_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="easistent-parser")
            client = httpx.AsyncClient(
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                timeout=10.0,
            )
            application.state.service = EasistentService(client, parser_executor)
        else:
            application.state.service = service
        if catalog is None:
            catalog_path = Path(os.environ.get("SCHOOL_CATALOG_PATH", ROOT / ".data" / "schools.json"))
            application.state.catalog = await asyncio.to_thread(SchoolCatalog.open, catalog_path)
        else:
            application.state.catalog = catalog
        application.state.search_capacity = SearchCapacity(25)
        application.state.rate_limiter = InMemoryRateLimiter(30, 60)
        try:
            yield
        finally:
            if client is not None:
                await client.aclose()
            if parser_executor is not None:
                parser_executor.shutdown(wait=True, cancel_futures=True)

    application = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    application.add_middleware(BodyLimitMiddleware, limit=BODY_LIMIT)
    application.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

    @application.middleware("http")
    async def security_and_rate_limit(request: Request, call_next: Callable[[Request], Awaitable[Any]]) -> Any:
        if not testing and request.url.path.startswith("/api/") and request.url.path != "/api/v1/health":
            client_ip = request.client.host if request.client else "unknown"
            if not await request.app.state.rate_limiter.allow(client_ip):
                return JSONResponse(
                    status_code=429,
                    content={"v": 1, "error": {"code": "RATE_LIMITED", "message": "Preveč zahtev. Poskusi znova čez minuto."}},
                    headers={"Retry-After": "60"},
                )
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @application.exception_handler(AppError)
    async def app_error_handler(_request: Request, error: AppError) -> JSONResponse:
        headers = {"Retry-After": "5"} if error.code == "SERVER_BUSY" else None
        return JSONResponse(
            status_code=error.status_code,
            content={"v": 1, "error": {"code": error.code, "message": error.message}},
            headers=headers,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=400,
            content={"v": 1, "error": {"code": "INVALID_REQUEST", "message": "Zahteva ni veljavna."}},
        )

    @application.exception_handler(Exception)
    async def internal_error_handler(_request: Request, error: Exception) -> JSONResponse:
        logger.error(
            "Unhandled application error",
            exc_info=(type(error), error, error.__traceback__),
        )
        return JSONResponse(
            status_code=500,
            content={"v": 1, "error": {"code": "INTERNAL_ERROR", "message": "Prišlo je do notranje napake."}},
        )

    @application.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={"app_prefix": _forwarded_prefix(request)},
        )

    @application.get("/api/v1/health")
    async def health(request: Request) -> dict[str, Any]:
        pages = await request.app.state.service.page_cache.size()
        return {"ok": True, "cache": {"pages": pages}}

    @application.get("/api/v1/schools")
    async def schools(request: Request) -> dict[str, Any]:
        return {"v": 1, "schools": request.app.state.catalog.list()}

    @application.post("/api/v1/schools/inspect")
    async def inspect_school(body: TimetableBody, request: Request) -> dict[str, Any]:
        try:
            result = (await request.app.state.service.inspect(body.timetableUrl))["inspection"]
            await asyncio.to_thread(
                request.app.state.catalog.add, result["school"]["token"], result["school"]["name"]
            )
            return result
        except AppError as error:
            await _remove_permanently_missing_school(request.app.state.catalog, body.timetableUrl, error)
            raise

    @application.post("/api/v1/availability")
    async def availability(body: AvailabilityBody, request: Request) -> dict[str, Any]:
        capacity: SearchCapacity = request.app.state.search_capacity
        if not await capacity.acquire():
            raise AppError(503, "SERVER_BUSY", "Strežnik je trenutno zaseden. Poskusi znova.")
        try:
            result = await request.app.state.service.availability(
                body.timetableUrl, body.date, body.period
            )
            await asyncio.to_thread(
                request.app.state.catalog.add, result["school"]["token"], result["school"]["name"]
            )
            return result
        except AppError as error:
            await _remove_permanently_missing_school(request.app.state.catalog, body.timetableUrl, error)
            raise
        finally:
            await capacity.release()

    return application


def _forwarded_prefix(request: Request) -> str:
    prefix = request.headers.get("x-forwarded-prefix", "").strip().rstrip("/")
    segments = prefix.split("/")[1:]
    return (
        prefix
        if FORWARDED_PREFIX.fullmatch(prefix) and all(segment not in {".", ".."} for segment in segments)
        else ""
    )


async def _remove_permanently_missing_school(
    catalog: SchoolCatalog, timetable_url: str, error: AppError
) -> None:
    if error.code != "TIMETABLE_NOT_FOUND":
        return
    parsed = parse_public_timetable_url(timetable_url)
    submitted = urlsplit(parsed["url"])
    normalized = urlunsplit((submitted.scheme, submitted.netloc, submitted.path.rstrip("/"), "", ""))
    stored = catalog.get(parsed["schoolToken"])
    if stored is not None and stored["timetableUrl"] == normalized:
        await asyncio.to_thread(catalog.remove, parsed["schoolToken"])


app = create_app()
