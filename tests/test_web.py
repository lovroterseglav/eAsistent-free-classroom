from __future__ import annotations

import asyncio
import unittest

import httpx
import uvloop

from cache import AsyncTtlLruCache
from catalog import SchoolCatalog, timetable_url_for_token
from tests.fixtures import SCHOOL_URL, TOKEN
from web import create_app


class StubService:
    def __init__(self) -> None:
        self.page_cache = AsyncTtlLruCache(300, 10)
        self.release = asyncio.Event()
        self.all_entered = asyncio.Event()
        self.entered = 0
        self.block = False

    async def inspect(self, _url: str):
        return {"inspection": inspection(), "classrooms": [{"id": "1", "name": "1", "url": "unused"}]}

    async def availability(self, _url: str, requested_date: str, period: int):
        if self.block:
            self.entered += 1
            if self.entered == 25:
                self.all_entered.set()
            await self.release.wait()
        return {
            "v": 1,
            "school": inspection()["school"],
            "date": requested_date,
            "period": inspection()["periods"][0] | {"number": period},
            "rooms": {"free": [{"id": "1", "name": "1"}], "unknown": [], "occupiedCount": 0, "totalCount": 1},
            "fetchedAt": "2026-11-17T10:00:00+01:00",
        }


def inspection():
    return {
        "v": 1,
        "school": {"token": TOKEN, "name": "Gimnazija Kranj", "canonicalUrl": SCHOOL_URL},
        "dates": ["2026-11-17"],
        "periods": [{"number": 1, "label": "1. ura", "startMinute": 430, "endMinute": 475}],
        "schoolYear": {"start": "2026-09-01", "end": "2027-08-31"},
        "classroomCount": 1,
        "fetchedAt": "2026-11-17T10:00:00+01:00",
    }


class WebTest(unittest.IsolatedAsyncioTestCase):
    loop_factory = staticmethod(uvloop.new_event_loop)

    async def asyncSetUp(self) -> None:
        self.service = StubService()
        self.catalog = SchoolCatalog.memory([])
        self.app = create_app(service=self.service, catalog=self.catalog, testing=True)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://testserver"
        )

    async def asyncTearDown(self) -> None:
        self.service.release.set()
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)

    async def test_renders_existing_interface_and_security_headers(self) -> None:
        response = await self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Proste učilnice", response.text)
        self.assertIn('/static/styles.css', response.text)
        self.assertIn('/static/app.js', response.text)
        self.assertIn("default-src 'self'", response.headers["content-security-policy"])

    async def test_health_catalog_inspection_and_availability(self) -> None:
        health = await self.client.get("/api/v1/health")
        self.assertEqual(health.json(), {"ok": True, "cache": {"pages": 0}})
        listed = await self.client.get("/api/v1/schools")
        self.assertEqual(listed.json(), {"v": 1, "schools": []})
        inspected = await self.client.post("/api/v1/schools/inspect", json={"timetableUrl": SCHOOL_URL})
        self.assertEqual(inspected.status_code, 200)
        self.assertEqual(inspected.json()["school"]["name"], "Gimnazija Kranj")
        self.assertEqual(self.catalog.get(TOKEN)["timetableUrl"], timetable_url_for_token(TOKEN))
        available = await self.client.post("/api/v1/availability", json={
            "timetableUrl": SCHOOL_URL, "date": "2026-11-17", "period": 1,
        })
        self.assertEqual(available.status_code, 200)
        self.assertEqual(available.json()["rooms"]["free"][0]["name"], "1")

    async def test_validation_and_body_limit_use_json_errors(self) -> None:
        invalid = await self.client.post("/api/v1/availability", json={"date": "bad"})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["error"]["code"], "INVALID_REQUEST")
        oversized = await self.client.post(
            "/api/v1/schools/inspect",
            content=b"x" * 9_000,
            headers={"content-type": "application/json"},
        )
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(oversized.json()["error"]["code"], "INVALID_REQUEST")

    async def test_admits_25_searches_and_rejects_the_26th(self) -> None:
        self.service.block = True
        payload = {"timetableUrl": SCHOOL_URL, "date": "2026-11-17", "period": 1}
        requests = [asyncio.create_task(self.client.post("/api/v1/availability", json=payload)) for _ in range(25)]
        await asyncio.wait_for(self.service.all_entered.wait(), timeout=2)
        health = await self.client.get("/api/v1/health")
        self.assertEqual(health.status_code, 200)
        overflow = await self.client.post("/api/v1/availability", json=payload)
        self.assertEqual(overflow.status_code, 503)
        self.assertEqual(overflow.json()["error"]["code"], "SERVER_BUSY")
        self.assertEqual(overflow.headers["retry-after"], "5")
        self.service.release.set()
        responses = await asyncio.gather(*requests)
        self.assertTrue(all(response.status_code == 200 for response in responses))
