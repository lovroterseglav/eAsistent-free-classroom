from __future__ import annotations

import asyncio
import unittest
from concurrent.futures import ThreadPoolExecutor

import httpx
import uvloop

from easistent import AppError, EasistentService
from tests.fixtures import (
    CLASS_AJAX_URL,
    CLASS_PAGE,
    ROOM_CANCELLED_PAGE,
    ROOM_INDEX_PAGE,
    ROOM_ONE_AJAX_URL,
    ROOM_ONE_URL,
    ROOM_TWO_AJAX_URL,
    ROOM_TWO_URL,
    SCHOOL_URL,
    TOKEN,
    page_for_date,
)


def html(value: str, status: int = 200) -> httpx.Response:
    return httpx.Response(status, text=value, headers={"content-type": "text/html; charset=utf-8"})


class EasistentServiceTest(unittest.IsolatedAsyncioTestCase):
    loop_factory = staticmethod(uvloop.new_event_loop)

    async def asyncSetUp(self) -> None:
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.clients: list[httpx.AsyncClient] = []

    async def asyncTearDown(self) -> None:
        for client in self.clients:
            await client.aclose()
        self.executor.shutdown(wait=True, cancel_futures=True)

    def service(
        self,
        handler,
        *,
        sleep=asyncio.sleep,
        today=lambda: "2026-11-17",
        upstream_limit: int = 32,
    ) -> EasistentService:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.clients.append(client)
        return EasistentService(
            client,
            self.executor,
            sleep=sleep,
            today=today,
            upstream_limit=upstream_limit,
        )

    async def test_inspect_and_current_week_availability(self) -> None:
        pages = {
            SCHOOL_URL: CLASS_PAGE,
            ROOM_ONE_URL: ROOM_INDEX_PAGE,
            ROOM_TWO_URL: ROOM_CANCELLED_PAGE,
            ROOM_ONE_AJAX_URL: page_for_date("2026-11-17"),
            ROOM_TWO_AJAX_URL: ROOM_CANCELLED_PAGE,
        }

        async def handler(request: httpx.Request) -> httpx.Response:
            return html(pages[str(request.url)]) if str(request.url) in pages else html("missing", 404)

        service = self.service(handler)
        inspected = await service.inspect(SCHOOL_URL)
        self.assertEqual(inspected["inspection"]["school"]["name"], "Gimnazija Kranj")
        self.assertEqual(inspected["inspection"]["classroomCount"], 2)
        result = await service.availability(SCHOOL_URL, "2026-11-17", 1)
        self.assertEqual([room["name"] for room in result["rooms"]["free"]], ["1", "11"])
        self.assertEqual(result["rooms"]["unknown"], [])

    async def test_requests_target_week_with_ajax_headers(self) -> None:
        requested: list[httpx.Request] = []
        target_class = CLASS_AJAX_URL.replace("/12/0/1", "/13/0/1")
        target_one = ROOM_ONE_AJAX_URL.replace("/12/0/1", "/13/0/1")
        target_two = ROOM_TWO_AJAX_URL.replace("/12/0/1", "/13/0/1")
        pages = {
            SCHOOL_URL: CLASS_PAGE,
            ROOM_ONE_URL: ROOM_INDEX_PAGE,
            ROOM_TWO_URL: ROOM_CANCELLED_PAGE,
            target_class: page_for_date("2026-11-27"),
            target_one: page_for_date("2026-11-27"),
            target_two: page_for_date("2026-11-27", occupied=True),
        }

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.append(request)
            return html(pages[str(request.url)]) if str(request.url) in pages else html("missing", 404)

        result = await self.service(handler).availability(SCHOOL_URL, "2026-11-27", 1)
        self.assertEqual([room["name"] for room in result["rooms"]["free"]], ["1"])
        self.assertEqual(result["rooms"]["occupiedCount"], 1)
        ajax = [request for request in requested if "/ajax_urnik/" in request.url.path]
        self.assertEqual(len(ajax), 3)
        for request in ajax:
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.headers["X-Requested-With"], "XMLHttpRequest")
            self.assertNotIn("cookie", request.headers)
            self.assertEqual(request.url.query, b"")

    async def test_retries_three_times_then_succeeds(self) -> None:
        attempts = 0
        delays: list[float] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            if str(request.url) == ROOM_ONE_URL:
                return html(ROOM_INDEX_PAGE)
            attempts += 1
            return html("unavailable", 503) if attempts <= 3 else html(CLASS_PAGE)

        async def wait(delay: float) -> None:
            delays.append(delay)

        result = await self.service(handler, sleep=wait).inspect(SCHOOL_URL)
        self.assertEqual(result["inspection"]["school"]["name"], "Gimnazija Kranj")
        self.assertEqual(attempts, 4)
        self.assertEqual(delays, [0.25, 0.5, 1.0])

    async def test_does_not_retry_not_found(self) -> None:
        attempts = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return html("missing", 404)

        with self.assertRaises(AppError) as raised:
            await self.service(handler).inspect(SCHOOL_URL)
        self.assertEqual(raised.exception.code, "TIMETABLE_NOT_FOUND")
        self.assertEqual(attempts, 1)

    async def test_limits_one_search_to_six_room_requests(self) -> None:
        room_count = 18
        options = "".join(f'<option value="{index}">{index}</option>' for index in range(1, room_count + 1))
        room_index = ROOM_INDEX_PAGE.replace(
            '<option value="1333027">1</option>\n    <option value="1333035">11</option>', options
        )
        active = 0
        maximum = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal active, maximum
            url = str(request.url)
            if url == SCHOOL_URL:
                return html(CLASS_PAGE)
            if url == ROOM_ONE_URL:
                return html(room_index)
            if f"/urniki/{TOKEN}/ucilnice/" in url:
                active += 1
                maximum = max(maximum, active)
                await asyncio.sleep(0.01)
                active -= 1
                return html(page_for_date("2026-11-17"))
            return html("missing", 404)

        result = await self.service(handler).availability(SCHOOL_URL, "2026-11-17", 1)
        self.assertEqual(result["rooms"]["totalCount"], room_count)
        self.assertLessEqual(maximum, 6)

    async def test_global_upstream_limit_and_single_flight(self) -> None:
        active = 0
        maximum = 0
        counts: dict[str, int] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal active, maximum
            url = str(request.url)
            counts[url] = counts.get(url, 0) + 1
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0.01)
            active -= 1
            return html(CLASS_PAGE)

        service = self.service(handler, upstream_limit=4)
        urls = [f"{SCHOOL_URL.rsplit('/', 1)[0]}/{index}" for index in range(100, 120)]
        await asyncio.gather(*(service.fetch_page(url) for url in urls))
        self.assertLessEqual(maximum, 4)

        shared = f"{SCHOOL_URL.rsplit('/', 1)[0]}/999"
        await asyncio.gather(*(service.fetch_page(shared) for _ in range(20)))
        self.assertEqual(counts[shared], 1)

    async def test_identical_availability_searches_share_work(self) -> None:
        service = self.service(lambda _request: html(CLASS_PAGE))
        calls = 0

        async def calculate(_parsed, requested_date: str, period_number: int):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return {"date": requested_date, "period": {"number": period_number}}

        service._availability = calculate
        results = await asyncio.gather(*(
            service.availability(SCHOOL_URL, "2026-11-17", 1) for _ in range(20)
        ))
        self.assertEqual(calls, 1)
        self.assertTrue(all(result == results[0] for result in results))

    async def test_rejects_invalid_dates(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return html(CLASS_PAGE if str(request.url) == SCHOOL_URL else ROOM_INDEX_PAGE)

        service = self.service(handler)
        for value, code in (("2027-02-29", "INVALID_DATE"), ("2028-01-10", "DATE_OUTSIDE_SCHOOL_YEAR")):
            with self.assertRaises(AppError) as raised:
                await service.availability(SCHOOL_URL, value, 1)
            self.assertEqual(raised.exception.code, code)
