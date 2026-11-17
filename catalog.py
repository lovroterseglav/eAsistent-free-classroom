from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable


TOKEN_PATTERN = re.compile(r"^[a-f0-9]{40}$")

INITIAL_SCHOOLS = (
    {"token": "56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33", "name": "Gimnazija Kranj"},
    {"token": "2f03ef5de7536804b07afbffc263a33d65af35c0", "name": "Osnovna šola Antona Ukmarja Koper"},
    {"token": "14f05e42fa365dc9649ce3d2cdf56fbaf6b32b4f", "name": "Osnovna šola Center"},
    {"token": "1f2b48c1b39236899435a3624138878cd5d826c6", "name": "Osnovna šola Čepovan"},
    {"token": "ae6546d36e50262b8557eba15303aeed947d663c", "name": "Osnovna šola Dušana Flisa Hoče"},
    {"token": "46e2748a3d3ed5400ebbdad694ef36073eaa2832", "name": "Osnovna šola Jožeta Moškriča Ljubljana"},
    {"token": "f54bd5135aa9f3ce3f8755f4ebdf8dd608fc596a", "name": "Osnovna šola Lava Celje"},
    {"token": "d8c031c6455bccd3f7dde5f94b1aa541e892c001", "name": "Osnovna šola Lucija"},
    {"token": "9f92f62a620b872155b2abe2b96a94111c93995f", "name": "Osnovna šola Milojke Štrukelj Nova Gorica"},
    {"token": "5dd8df2c1a1a7e3f78fc948150be030e7bc1a0bd", "name": "Osnovna šola Miška Kranjca Ljubljana"},
    {"token": "6cec1af02a33972cd9d11d5feb34ac70e690377c", "name": "Osnovna šola Raka"},
    {"token": "3b7d77bde3c96214bbe98428e79c64fab242c4a7", "name": "Osnovna šola Srečka Kosovela Sežana"},
    {"token": "3be79be35a50238f05efc1b9a0465bb655e06589", "name": "Osnovna šola Štore"},
    {"token": "7e40ec558fe336c35a07a91ba6e78bc638fd9080", "name": "Osnovna šola Zalog"},
    {"token": "7721e2fa758aeff2da5ab24956948b0806b913b6", "name": "Srednja šola Jesenice"},
    {"token": "250363fbd15a5a588225b12e7bfb6f8b1a5d432f", "name": "Srednja zdravstvena šola Ljubljana"},
    {"token": "34547418f4a775945ecc88dbb313511498e19e75", "name": "Šolski center Novo mesto - Srednja zdravstvena in kemijska šola"},
)


def timetable_url_for_token(token: str) -> str:
    return f"https://urniki.easistent.com/urniki/{token}"


def _normalize_school(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    token = str(value.get("token", "")).strip().lower()
    name = " ".join(str(value.get("name", "")).split())
    if not TOKEN_PATTERN.fullmatch(token) or not name:
        return None
    return {"token": token, "name": name}


def _valid_schools(values: Iterable[Any]) -> list[dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for value in values:
        school = _normalize_school(value)
        if school is not None and school["token"] not in result:
            result[school["token"]] = school
    return list(result.values())


def _merge_schools(*collections: Iterable[Any]) -> list[dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for collection in collections:
        for school in _valid_schools(collection):
            result[school["token"]] = school
    return list(result.values())


def _sort_key(value: str) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFD", value.casefold())
        if unicodedata.category(character) != "Mn"
    )


class SchoolCatalog:
    def __init__(self, schools: Iterable[Any], file_path: Path | None = None) -> None:
        self._schools = {school["token"]: school for school in _valid_schools(schools)}
        self._file_path = file_path
        self._lock = threading.RLock()

    @classmethod
    def memory(cls, schools: Iterable[Any] = INITIAL_SCHOOLS) -> SchoolCatalog:
        return cls(schools)

    @classmethod
    def open(cls, file_path: str | Path) -> SchoolCatalog:
        path = Path(file_path)
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(parsed, dict) or parsed.get("v") != 1 or not isinstance(parsed.get("schools"), list):
                raise ValueError("Invalid school catalog file")
            stored = _valid_schools(parsed["schools"])
        except FileNotFoundError:
            stored = []
        except (OSError, ValueError, json.JSONDecodeError):
            if path.exists():
                path.replace(path.with_name(f"{path.name}.corrupt-{int(time.time() * 1000)}"))
            stored = []
        catalog = cls(_merge_schools(INITIAL_SCHOOLS, stored), path)
        catalog._persist()
        return catalog

    def list(self) -> list[dict[str, str]]:
        with self._lock:
            schools = [
                {**school, "timetableUrl": timetable_url_for_token(school["token"])}
                for school in self._schools.values()
            ]
        return sorted(schools, key=lambda school: _sort_key(school["name"]))

    def get(self, token: str) -> dict[str, str] | None:
        with self._lock:
            school = self._schools.get(token.lower())
            if school is None:
                return None
            return {**school, "timetableUrl": timetable_url_for_token(school["token"])}

    def add(self, token: str, name: str) -> bool:
        school = _normalize_school({"token": token, "name": name})
        if school is None:
            return False
        with self._lock:
            if school["token"] in self._schools:
                return False
            self._schools[school["token"]] = school
            self._persist()
            return True

    def remove(self, token: str) -> bool:
        with self._lock:
            if self._schools.pop(token.lower(), None) is None:
                return False
            self._persist()
            return True

    def _persist(self) -> None:
        if self._file_path is None:
            return
        path = self._file_path
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_name(f".{path.name}.lock")
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
            )
            temporary = Path(temporary_name)
            try:
                payload = {"v": 1, "schools": list(self._schools.values())}
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    os.fchmod(handle.fileno(), 0o600)
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, path)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
