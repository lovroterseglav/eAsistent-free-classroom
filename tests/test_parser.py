from __future__ import annotations

import unittest

from easistent import (
    ajax_timetable_url,
    parse_classrooms,
    parse_schedule_metadata,
    room_availability,
    school_week_number,
    school_year_bounds,
    sort_rooms,
)
from tests.fixtures import (
    CLASS_PAGE,
    ROOM_CANCELLED_PAGE,
    ROOM_FREE_PAGE,
    ROOM_INDEX_PAGE,
    ROOM_ONE_URL,
    TOKEN,
)


class ParserTest(unittest.TestCase):
    def test_parses_schedule_metadata(self) -> None:
        metadata = parse_schedule_metadata(CLASS_PAGE)
        self.assertEqual(metadata["schoolName"], "Gimnazija Kranj")
        self.assertEqual(metadata["dates"], ["2026-11-17"])
        self.assertEqual(metadata["periods"], [{
            "number": 1,
            "label": "1. ura",
            "startMinute": 430,
            "endMinute": 475,
        }])

    def test_constructs_ajax_url_from_captured_path(self) -> None:
        html = f'<script>const url = "\\/urniki\\/ajax_urnik\\/{TOKEN}\\/815595\\/0\\/0\\/0\\/12\\/0\\/1";</script>'
        self.assertEqual(
            ajax_timetable_url(html, f"https://urniki.easistent.com/urniki/{TOKEN}/razredi/748283", 13),
            f"https://urniki.easistent.com/urniki/ajax_urnik/{TOKEN}/815595/0/0/0/13/0/1",
        )

    def test_constructs_ajax_url_from_page_variables(self) -> None:
        source = f"https://urniki.easistent.com/urniki/{TOKEN}/ucilnice/1333027"
        variables = "<script>var id_razred='0'; var id_profesor='0'; var id_dijak='0'; var id_ucilnica='9123'; var id_interesna_dejavnost='0';</script>"
        self.assertEqual(
            ajax_timetable_url(variables, source, 13),
            f"https://urniki.easistent.com/urniki/ajax_urnik/{TOKEN}/0/0/0/9123/13/0/1",
        )
        foreign = variables + "/urniki/ajax_urnik/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/0/0/0/9123/12/0/1"
        self.assertIsNone(ajax_timetable_url(foreign, source, 13))
        self.assertIsNone(ajax_timetable_url(variables, "https://example.com/urniki/x", 13))

    def test_discovers_and_sorts_classrooms(self) -> None:
        rooms = parse_classrooms(ROOM_INDEX_PAGE, ROOM_ONE_URL)
        self.assertEqual([room["name"] for room in rooms], ["1", "11"])
        self.assertTrue(rooms[1]["url"].endswith("/ucilnice/1333035"))
        self.assertEqual(
            [room["name"] for room in sort_rooms([{"name": "11"}, {"name": "bazen"}, {"name": "2"}])],
            ["2", "11", "bazen"],
        )

    def test_cancelled_and_empty_cells_are_free(self) -> None:
        self.assertEqual(room_availability(ROOM_FREE_PAGE, "2026-11-17", 1), "free")
        self.assertEqual(room_availability(ROOM_CANCELLED_PAGE, "2026-11-17", 1), "free")
        self.assertEqual(room_availability(ROOM_FREE_PAGE, "2026-11-17", 2), "unknown")

    def test_school_week_number_uses_school_year(self) -> None:
        bounds = school_year_bounds("2027-01-12")
        self.assertEqual(bounds, {"start": "2026-09-01", "end": "2027-08-31"})
        self.assertEqual(school_week_number("2026-09-01", bounds), 1)
        self.assertEqual(school_week_number("2026-11-17", bounds), 12)
        self.assertEqual(school_week_number("2026-11-27", bounds), 13)
        self.assertEqual(school_week_number("2027-08-31", bounds), 53)
        self.assertIsNone(school_week_number("2026-08-31", bounds))
        self.assertIsNone(school_week_number("2027-02-29", bounds))
