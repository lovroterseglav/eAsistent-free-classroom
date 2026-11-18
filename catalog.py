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
    def memory(cls, schools: Iterable[Any] = ()) -> SchoolCatalog:
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
        catalog = cls(stored, path)
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
