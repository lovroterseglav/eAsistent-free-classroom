from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from catalog import SchoolCatalog, timetable_url_for_token


class CatalogTest(unittest.TestCase):
    def test_persists_and_deduplicates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "schools.json"
            catalog = SchoolCatalog.open(path)
            self.assertEqual(catalog.list(), [])
            token = "a" * 40
            self.assertTrue(catalog.add(token, "  Druga   šola  "))
            self.assertFalse(catalog.add(token, "Changed"))
            self.assertEqual(catalog.get(token)["name"], "Druga šola")
            self.assertEqual(catalog.get(token)["timetableUrl"], timetable_url_for_token(token))
            reloaded = SchoolCatalog.open(path)
            self.assertEqual(len(reloaded.list()), 1)

    def test_preserves_corrupt_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "schools.json"
            path.write_text("{broken", encoding="utf-8")
            catalog = SchoolCatalog.open(path)
            self.assertEqual(catalog.list(), [])
            self.assertTrue(any(item.name.startswith("schools.json.corrupt-") for item in path.parent.iterdir()))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["v"], 1)

    def test_memory_catalog_is_empty_by_default(self) -> None:
        self.assertEqual(SchoolCatalog.memory().list(), [])
