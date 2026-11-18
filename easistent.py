from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import unicodedata
from concurrent.futures import Executor
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Awaitable, Callable, TypeVar
from urllib.parse import urljoin, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import httpx
from bs4 import BeautifulSoup, Tag

from cache import AsyncTtlLruCache


logger = logging.getLogger("easistent")
ALLOWED_HOSTS = {"urniki.easistent.com", "www.easistent.com"}
SCHOOL_TOKEN = re.compile(r"^[a-f0-9]{40}$", re.IGNORECASE)
AJAX_PATH = re.compile(
    r"/urniki/ajax_urnik/([a-f0-9]{40})/(\d+)/(\d+)/(\d+)/(\d+)/(\d+)/(\d+)/(\d+)",
    re.IGNORECASE,
)
AJAX_PATH_FULL = re.compile(r"^/urniki/ajax_urnik/([a-f0-9]{40})(?:/\d+){7}/?$", re.IGNORECASE)
PERIOD_ID = re.compile(r"^urnik-ura-(-?\d+)$")
CELL_ID = re.compile(r"^ednevnik-seznam_ur_teden-td-(-?\d+)-(\d{4}-\d{2}-\d{2})$")
TIME_RANGE = re.compile(r"(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})")
RETRY_DELAYS = (0.250, 0.500, 1.000)
RETRYABLE_STATUS = {429, 502, 503, 504}
MAX_HTML_SIZE = 2 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 10.0
AVAILABILITY_DEADLINE_SECONDS = 60.0


class AppError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        upstream_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.upstream_status = upstream_status


@dataclass(frozen=True)
class PageResult:
    html: str
    response_url: str


@dataclass(frozen=True)
class RawResponse:
    status: int
    headers: httpx.Headers
    body: bytes
    encoding: str


T = TypeVar("T")


def normalize_space(value: Any) -> str:
    return " ".join(str(value or "").split())


def parse_period_range(value: str) -> dict[str, int] | None:
    match = TIME_RANGE.search(normalize_space(value))
    if match is None:
        return None
    start = int(match.group(1)) * 60 + int(match.group(2))
    end = int(match.group(3)) * 60 + int(match.group(4))
    if start < 0 or end <= start or end > 24 * 60:
        return None
    return {"startMinute": start, "endMinute": end}


def parse_schedule_metadata(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.find(class_="urnik_title")
    school_name = normalize_space(title.get_text(" ", strip=True) if title else "")
    periods: list[dict[str, Any]] = []
    for header in soup.find_all("th", id=re.compile(r"^urnik-ura-")):
        match = PERIOD_ID.fullmatch(header.get("id", ""))
        range_element = header.find(class_="potek-ure")
        parsed_range = parse_period_range(range_element.get_text(" ", strip=True) if range_element else "")
        if match is None or parsed_range is None:
            continue
        number = int(match.group(1))
        periods.append({"number": number, "label": f"{number}. ura", **parsed_range})
    periods.sort(key=lambda period: period["number"])
    dates: set[str] = set()
    for cell in soup.find_all("td", id=re.compile(r"^ednevnik-seznam_ur_teden-td-")):
        match = CELL_ID.fullmatch(cell.get("id", ""))
        if match is not None:
            dates.add(match.group(2))
    return {"schoolName": school_name, "dates": sorted(dates), "periods": periods}


def parse_public_timetable_url(value: str) -> dict[str, str]:
    try:
        parsed = urlsplit(value.strip())
    except ValueError as error:
        raise AppError(400, "INVALID_TIMETABLE_URL", "Povezava do urnika ni veljavna.") from error
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise AppError(400, "INVALID_TIMETABLE_URL", "Dovoljene so samo javne HTTPS-povezave eAsistent.")
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 2 or segments[0] != "urniki" or SCHOOL_TOKEN.fullmatch(segments[1]) is None:
        raise AppError(400, "INVALID_TIMETABLE_URL", "Povezava ne vsebuje veljavne oznake šole.")
    if len(segments) > 2:
        known_entity = segments[2] in {"razredi", "ucilnice"}
        collection = len(segments) == 3
        single_entity = len(segments) == 4 and segments[3].isdigit()
        student = (
            len(segments) == 6
            and segments[3].isdigit()
            and segments[4] == "dijak"
            and segments[5].isdigit()
        )
        if not known_entity or not (collection or single_entity or student):
            raise AppError(400, "INVALID_TIMETABLE_URL", "Pot javnega urnika ni podprta.")
    token = segments[1].lower()
    normalized = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
    return {
        "url": normalized,
        "schoolToken": token,
        "schoolRoot": f"{parsed.scheme}://{parsed.netloc}/urniki/{token}",
    }


def validate_ajax_timetable_url(value: str, expected_school_token: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise AppError(502, "INVALID_UPSTREAM_URL", "eAsistent je podal neveljavno notranjo povezavo.") from error
    match = AJAX_PATH_FULL.fullmatch(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_HOSTS
        or match is None
        or match.group(1).lower() != expected_school_token.lower()
    ):
        raise AppError(502, "INVALID_UPSTREAM_URL", "eAsistent je podal nedovoljeno notranjo povezavo.")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _script_number(html: str, name: str) -> str | None:
    match = re.search(rf"(?:var\s+)?{re.escape(name)}\s*=\s*['\"]?(\d+)['\"]?", html, re.IGNORECASE)
    return match.group(1) if match else None


def ajax_timetable_url(html: str, source_url: str, week: int) -> str | None:
    if not isinstance(week, int) or week < 1 or week > 60:
        return None
    try:
        parsed = parse_public_timetable_url(source_url)
        source = urlsplit(source_url)
    except AppError:
        return None
    token = parsed["schoolToken"]
    unescaped = html.replace("\\/", "/")
    match = AJAX_PATH.search(unescaped)
    if match is not None:
        if match.group(1).lower() != token:
            return None
        values = [match.group(index) for index in range(2, 6)]
        activity_id = match.group(7)
        query_version = match.group(8)
    else:
        values = [
            _script_number(unescaped, "id_razred") or "0",
            _script_number(unescaped, "id_profesor") or "0",
            _script_number(unescaped, "id_dijak") or "0",
            _script_number(unescaped, "id_ucilnica") or "0",
        ]
        path_segments = [segment for segment in source.path.split("/") if segment]
        if len(path_segments) >= 3 and path_segments[2] == "razredi" and values[0] == "0":
            return None
        if len(path_segments) >= 4 and path_segments[2] == "ucilnice" and values[3] == "0":
            return None
        if all(value == "0" for value in values):
            return None
        activity_id = _script_number(unescaped, "id_interesna_dejavnost") or "0"
        query_version = _script_number(unescaped, "qversion") or "1"
    segments = [*values, str(week), activity_id, query_version]
    if any(not value.isdigit() for value in segments):
        return None
    return f"{source.scheme}://{source.netloc}/urniki/ajax_urnik/{token}/{'/'.join(segments)}"


def classroom_index_candidates(html: str, source_url: str, school_root: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found: dict[str, None] = {}
    for element in soup.find_all(["a", "option", "form"]):
        raw = element.get("href") or element.get("value") or element.get("action")
        if not raw:
            continue
        candidate = urljoin(source_url, str(raw))
        if "/ucilnice" in urlsplit(candidate).path:
            found[candidate] = None
    found[f"{school_root}/ucilnice"] = None
    return list(found)


def parse_classrooms(html: str, source_url: str) -> list[dict[str, str]]:
    source = urlsplit(source_url)
    match = re.fullmatch(r"(.*?/ucilnice)(?:/\d+)?/?", source.path)
    if match is None:
        return []
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    classrooms: list[dict[str, str]] = []
    parameter = soup.find(id="id_parameter")
    for option in parameter.find_all("option") if isinstance(parameter, Tag) else []:
        classroom_id = str(option.get("value", "")).strip()
        name = normalize_space(option.get_text(" ", strip=True))
        if not classroom_id or not name:
            continue
        if classroom_id.isdigit():
            url = f"{source.scheme}://{source.netloc}{match.group(1)}/{classroom_id}"
        else:
            url = urljoin(source_url, classroom_id)
            if "/ucilnice/" not in urlsplit(url).path:
                continue
        if url in seen:
            continue
        seen.add(url)
        classrooms.append({"id": classroom_id, "name": name, "url": url})
    return classrooms


def _block_is_cancelled(block: Tag) -> bool:
    values = [" ".join(block.get("class", []))]
    for tag in block.find_all(class_="wl-tag-xs"):
        values.extend([str(tag.get("title", "")), tag.get_text(" ", strip=True)])
    value = normalize_space(" ".join(values)).casefold()
    return any(marker in value for marker in (
        "odpadla-ura", "odpadla ura", "neopravljena-ura", "neopravljena ura"
    ))


def room_availability(html: str, requested_date: str, period_number: int) -> str:
    soup = BeautifulSoup(html, "html.parser")
    cell = soup.find(id=f"ednevnik-seznam_ur_teden-td-{period_number}-{requested_date}")
    if not isinstance(cell, Tag):
        return "unknown"
    blocks = [
        block
        for block in cell.find_all(class_="ednevnik-seznam_ur_teden-blok-wrap")
        if isinstance(block, Tag)
    ]
    if not blocks:
        return "free"
    return "free" if all(_block_is_cancelled(block) for block in blocks) else "occupied"


def _natural_key(name: str) -> list[tuple[int, Any]]:
    normalized = "".join(
        character for character in unicodedata.normalize("NFD", name.casefold())
        if unicodedata.category(character) != "Mn"
    )
    return [(0, int(part)) if part.isdigit() else (1, part) for part in re.split(r"(\d+)", normalized)]


def sort_rooms(rooms: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(rooms, key=lambda room: _natural_key(room["name"]))


def valid_date(value: str) -> date | None:
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def school_year_bounds(today: str) -> dict[str, str]:
    current = valid_date(today)
    if current is None:
        raise ValueError("Today provider returned an invalid date")
    start_year = current.year if current.month >= 9 else current.year - 1
    return {"start": f"{start_year}-09-01", "end": f"{start_year + 1}-08-31"}


def school_week_number(value: str, bounds: dict[str, str]) -> int | None:
    requested = valid_date(value)
    start = valid_date(bounds["start"])
    end = valid_date(bounds["end"])
    if requested is None or start is None or end is None or requested < start or requested > end:
        return None
    week_start = start - timedelta(days=start.weekday())
    return (requested - week_start).days // 7 + 1


def current_date_in_ljubljana() -> str:
    return datetime.now(ZoneInfo("Europe/Ljubljana")).date().isoformat()


class EasistentService:
    def __init__(
        self,
        client: httpx.AsyncClient,
        parser_executor: Executor,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        today: Callable[[], str] = current_date_in_ljubljana,
        upstream_limit: int = 32,
    ) -> None:
        self.client = client
        self.parser_executor = parser_executor
        self.sleep = sleep
        self.today = today
        self.page_cache = AsyncTtlLruCache[PageResult](300, 1_500, 128 * 1024 * 1024)
        self.inspection_cache = AsyncTtlLruCache[dict[str, Any]](300, 100)
        self.availability_cache = AsyncTtlLruCache[dict[str, Any]](30, 1_000)
        self._upstream = asyncio.Semaphore(upstream_limit)
        self._inflight: dict[str, asyncio.Task[PageResult]] = {}
        self._inflight_lock = asyncio.Lock()
        self._availability_inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._availability_inflight_lock = asyncio.Lock()

    async def inspect(self, timetable_url: str) -> dict[str, Any]:
        parsed = parse_public_timetable_url(timetable_url)
        cached = await self.inspection_cache.get(parsed["url"])
        if cached is not None:
            return cached
        seed = await self.fetch_page(parsed["url"])
        seed_metadata = await self._parse(parse_schedule_metadata, seed.html)
        if not seed_metadata["schoolName"] or not seed_metadata["dates"] or not seed_metadata["periods"]:
            raise AppError(502, "UNSUPPORTED_TIMETABLE", "eAsistent ni vrnil prepoznavnega javnega urnika.")
        classrooms: list[dict[str, str]] = []
        room_metadata = seed_metadata
        candidates = await self._parse(
            classroom_index_candidates, seed.html, seed.response_url, parsed["schoolRoot"]
        )
        for candidate in candidates:
            try:
                page = seed if candidate == seed.response_url else await self.fetch_page(candidate)
                discovered = await self._parse(parse_classrooms, page.html, page.response_url)
                if discovered:
                    classrooms = sort_rooms(discovered)
                    metadata = await self._parse(parse_schedule_metadata, page.html)
                    if metadata["dates"] and metadata["periods"]:
                        room_metadata = metadata
                    break
            except AppError:
                continue
        if not classrooms:
            raise AppError(502, "CLASSROOMS_NOT_FOUND", "Popolnega seznama učilnic ni bilo mogoče odkriti.")
        result = {
            "inspection": {
                "v": 1,
                "school": {
                    "token": parsed["schoolToken"],
                    "name": seed_metadata["schoolName"],
                    "canonicalUrl": seed.response_url,
                },
                "dates": room_metadata["dates"],
                "periods": room_metadata["periods"],
                "schoolYear": school_year_bounds(self.today()),
                "classroomCount": len(classrooms),
                "fetchedAt": datetime.now().astimezone().isoformat(),
            },
            "classrooms": classrooms,
        }
        await self.inspection_cache.set(parsed["url"], result)
        return result

    async def availability(self, timetable_url: str, requested_date: str, period_number: int) -> dict[str, Any]:
        parsed = parse_public_timetable_url(timetable_url)
        cache_key = f"{parsed['schoolToken']}:{requested_date}:{period_number}"
        cached = await self.availability_cache.get(cache_key)
        if cached is not None:
            return cached
        async with self._availability_inflight_lock:
            task = self._availability_inflight.get(cache_key)
            if task is None:
                task = asyncio.create_task(
                    self._calculate_availability(parsed, requested_date, period_number, cache_key)
                )
                self._availability_inflight[cache_key] = task
                task.add_done_callback(
                    lambda completed, key=cache_key: asyncio.create_task(
                        self._remove_availability_inflight(key, completed)
                    )
                )
        return await asyncio.shield(task)

    async def _calculate_availability(
        self,
        parsed: dict[str, str],
        requested_date: str,
        period_number: int,
        cache_key: str,
    ) -> dict[str, Any]:
        try:
            async with asyncio.timeout(AVAILABILITY_DEADLINE_SECONDS):
                result = await self._availability(parsed, requested_date, period_number)
        except TimeoutError as error:
            raise AppError(504, "UPSTREAM_TIMEOUT", "eAsistent se ni pravočasno odzval.") from error
        await self.availability_cache.set(cache_key, result)
        return result

    async def _remove_availability_inflight(
        self, key: str, task: asyncio.Task[dict[str, Any]]
    ) -> None:
        async with self._availability_inflight_lock:
            if self._availability_inflight.get(key) is task:
                self._availability_inflight.pop(key, None)

    async def _availability(
        self, parsed: dict[str, str], requested_date: str, period_number: int
    ) -> dict[str, Any]:
        bounds = school_year_bounds(self.today())
        week = school_week_number(requested_date, bounds)
        if week is None:
            is_valid = valid_date(requested_date) is not None
            raise AppError(
                400,
                "DATE_OUTSIDE_SCHOOL_YEAR" if is_valid else "INVALID_DATE",
                "Datum ni v trenutnem šolskem letu." if is_valid else "Datum ni veljaven.",
            )
        inspected = await self.inspect(parsed["url"])
        target_metadata = {
            "dates": inspected["inspection"]["dates"],
            "periods": inspected["inspection"]["periods"],
        }
        if requested_date not in target_metadata["dates"]:
            seed = await self.fetch_page(parsed["url"])
            target_url = ajax_timetable_url(seed.html, seed.response_url, week)
            if target_url is None:
                raise AppError(502, "AJAX_CONFIG_NOT_FOUND", "eAsistent ni razkril poti do izbranega tedna.")
            try:
                target_page = await self.fetch_ajax_page(target_url, seed.response_url)
            except AppError as error:
                if error.code == "TIMETABLE_NOT_FOUND":
                    raise AppError(400, "DATE_NOT_IN_TIMETABLE", "Za izbrani datum urnik ni na voljo.") from error
                raise
            target_metadata = await self._parse(parse_schedule_metadata, target_page.html)
        if requested_date not in target_metadata["dates"]:
            raise AppError(400, "DATE_NOT_IN_TIMETABLE", "Za izbrani datum urnik ni na voljo.")
        period = next(
            (item for item in target_metadata["periods"] if item["number"] == period_number), None
        )
        if period is None:
            raise AppError(400, "INVALID_SLOT", "Šolska ura ni del naloženega urnika.")

        classrooms = inspected["classrooms"]
        states: list[dict[str, Any] | None] = [None] * len(classrooms)
        next_index = 0
        index_lock = asyncio.Lock()

        async def room_worker() -> None:
            nonlocal next_index
            while True:
                async with index_lock:
                    if next_index >= len(classrooms):
                        return
                    index = next_index
                    next_index += 1
                room = classrooms[index]
                target_url: str | None = None
                try:
                    public_page = await self.fetch_page(room["url"])
                    target_url = ajax_timetable_url(public_page.html, public_page.response_url, week)
                    page = (
                        await self.fetch_ajax_page(target_url, public_page.response_url)
                        if target_url is not None
                        else public_page
                    )
                    state = await self._parse(
                        room_availability, page.html, requested_date, period_number
                    )
                    if state == "unknown":
                        logger.warning(
                            "classroom_check_unknown school_token=%s room_id=%s "
                            "room_name=%r date=%s period=%s reason=missing_timetable_cell "
                            "ajax_url_found=%s page_url=%s",
                            parsed["schoolToken"],
                            room["id"],
                            room["name"],
                            requested_date,
                            period_number,
                            target_url is not None,
                            page.response_url,
                        )
                except asyncio.CancelledError:
                    raise
                except AppError as error:
                    state = "unknown"
                    logger.warning(
                        "classroom_check_failed school_token=%s room_id=%s room_name=%r "
                        "date=%s period=%s error_code=%s upstream_status=%s request_url=%s",
                        parsed["schoolToken"],
                        room["id"],
                        room["name"],
                        requested_date,
                        period_number,
                        error.code,
                        error.upstream_status,
                        target_url or room["url"],
                    )
                states[index] = {"room": room, "state": state}

        await asyncio.gather(*(
            room_worker() for _ in range(min(6, len(classrooms)))
        ))
        completed = [state for state in states if state is not None]
        free = sort_rooms([
            {"id": state["room"]["id"], "name": state["room"]["name"]}
            for state in completed if state["state"] == "free"
        ])
        unknown = sort_rooms([
            {"id": state["room"]["id"], "name": state["room"]["name"]}
            for state in completed if state["state"] == "unknown"
        ])
        return {
            "v": 1,
            "school": inspected["inspection"]["school"],
            "date": requested_date,
            "period": period,
            "rooms": {
                "free": free,
                "unknown": unknown,
                "occupiedCount": sum(1 for state in completed if state["state"] == "occupied"),
                "totalCount": len(classrooms),
            },
            "fetchedAt": datetime.now().astimezone().isoformat(),
        }

    async def fetch_page(self, url: str) -> PageResult:
        parsed = parse_public_timetable_url(url)
        return await self._cached_fetch(
            parsed["url"], lambda: self._fetch_page_uncached(parsed["url"])
        )

    async def fetch_ajax_page(self, url: str, referer: str) -> PageResult:
        referer_school = parse_public_timetable_url(referer)
        validated = validate_ajax_timetable_url(url, referer_school["schoolToken"])
        return await self._cached_fetch(
            validated,
            lambda: self._fetch_ajax_uncached(
                validated, referer, referer_school["schoolToken"]
            ),
        )

    async def _cached_fetch(
        self, key: str, factory: Callable[[], Awaitable[PageResult]]
    ) -> PageResult:
        cached = await self.page_cache.get(key)
        if cached is not None:
            return cached
        async with self._inflight_lock:
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.create_task(factory())
                self._inflight[key] = task
                task.add_done_callback(
                    lambda completed, cache_key=key: asyncio.create_task(
                        self._remove_inflight(cache_key, completed)
                    )
                )
        return await asyncio.shield(task)

    async def _remove_inflight(self, key: str, task: asyncio.Task[PageResult]) -> None:
        async with self._inflight_lock:
            if self._inflight.get(key) is task:
                self._inflight.pop(key, None)

    async def _fetch_page_uncached(self, initial_url: str) -> PageResult:
        current = initial_url
        for redirect_count in range(4):
            parse_public_timetable_url(current)
            response = await self._request_with_retry(current, {})
            if 300 <= response.status < 400:
                location = response.headers.get("location")
                if not location:
                    raise AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil neveljavno preusmeritev.")
                current = urljoin(current, location)
                parse_public_timetable_url(current)
                if redirect_count == 3:
                    break
                continue
            if response.status in {404, 410}:
                raise AppError(404, "TIMETABLE_NOT_FOUND", "Javni urnik ne obstaja več.", response.status)
            self._ensure_success(response)
            value = PageResult(response.body.decode(response.encoding, errors="replace"), current)
            await self.page_cache.set(initial_url, value, len(response.body))
            if current != initial_url:
                await self.page_cache.set(current, value, len(response.body))
            return value
        raise AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil preveč preusmeritev.")

    async def _fetch_ajax_uncached(
        self, initial_url: str, referer: str, school_token: str
    ) -> PageResult:
        current = initial_url
        headers = {"Referer": referer, "X-Requested-With": "XMLHttpRequest"}
        for redirect_count in range(4):
            validate_ajax_timetable_url(current, school_token)
            response = await self._request_with_retry(current, headers)
            if 300 <= response.status < 400:
                location = response.headers.get("location")
                if not location:
                    raise AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil neveljavno preusmeritev.")
                current = urljoin(current, location)
                validate_ajax_timetable_url(current, school_token)
                if redirect_count == 3:
                    break
                continue
            if response.status in {404, 410}:
                raise AppError(404, "TIMETABLE_NOT_FOUND", "Javni urnik ne obstaja več.", response.status)
            self._ensure_success(response)
            value = PageResult(response.body.decode(response.encoding, errors="replace"), current)
            await self.page_cache.set(initial_url, value, len(response.body))
            if current != initial_url:
                await self.page_cache.set(current, value, len(response.body))
            return value
        raise AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil preveč preusmeritev.")

    async def _request_with_retry(
        self, url: str, extra_headers: dict[str, str]
    ) -> RawResponse:
        headers = {
            "Accept": "text/html",
            "User-Agent": "ProsteUcilnice/1.0",
            **extra_headers,
        }
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                response = await self._request_once(url, headers)
                if response.status not in RETRYABLE_STATUS or attempt == len(RETRY_DELAYS):
                    return response
                logger.warning(
                    "easistent_request_retry url=%s failed_attempt=%s reason=http_status "
                    "status=%s delay_ms=%s",
                    url,
                    attempt + 1,
                    response.status,
                    round(RETRY_DELAYS[attempt] * 1_000),
                )
            except httpx.TimeoutException as error:
                if attempt == len(RETRY_DELAYS):
                    raise AppError(504, "UPSTREAM_TIMEOUT", "eAsistent se ni pravočasno odzval.") from error
                logger.warning(
                    "easistent_request_retry url=%s failed_attempt=%s reason=timeout delay_ms=%s",
                    url,
                    attempt + 1,
                    round(RETRY_DELAYS[attempt] * 1_000),
                )
            except httpx.RequestError as error:
                if attempt == len(RETRY_DELAYS):
                    raise AppError(502, "UPSTREAM_UNREACHABLE", "Povezave z eAsistentom ni bilo mogoče vzpostaviti.") from error
                logger.warning(
                    "easistent_request_retry url=%s failed_attempt=%s reason=request_error "
                    "error_type=%s delay_ms=%s",
                    url,
                    attempt + 1,
                    type(error).__name__,
                    round(RETRY_DELAYS[attempt] * 1_000),
                )
            await self.sleep(RETRY_DELAYS[attempt])
        raise AppError(502, "UPSTREAM_UNREACHABLE", "Povezave z eAsistentom ni bilo mogoče vzpostaviti.")

    async def _request_once(self, url: str, headers: dict[str, str]) -> RawResponse:
        async with self._upstream:
            async with self.client.stream(
                "GET", url, headers=headers, follow_redirects=False, timeout=REQUEST_TIMEOUT_SECONDS
            ) as response:
                content_length = int(response.headers.get("content-length", "0") or "0")
                if content_length > MAX_HTML_SIZE:
                    raise AppError(502, "UPSTREAM_SIZE", "Odgovor eAsistenta je prevelik.")
                body = bytearray()
                if not (300 <= response.status_code < 400) and response.status_code not in RETRYABLE_STATUS:
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_HTML_SIZE:
                            raise AppError(502, "UPSTREAM_SIZE", "Odgovor eAsistenta je prevelik.")
                return RawResponse(
                    status=response.status_code,
                    headers=response.headers,
                    body=bytes(body),
                    encoding=response.encoding or "utf-8",
                )

    @staticmethod
    def _ensure_success(response: RawResponse) -> None:
        if not 200 <= response.status < 300:
            raise AppError(502, "UPSTREAM_STATUS", f"eAsistent je vrnil HTTP {response.status}.", response.status)
        content_type = response.headers.get("content-type", "").lower()
        if "text/html" not in content_type:
            raise AppError(502, "UPSTREAM_TYPE", "eAsistent ni vrnil HTML-strani.")

    async def _parse(self, function: Callable[..., T], *args: Any) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.parser_executor, function, *args)
