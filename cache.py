from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Generic, TypeVar


T = TypeVar("T")


@dataclass(frozen=True)
class _Entry(Generic[T]):
    value: T
    size: int
    expires_at: float


class AsyncTtlLruCache(Generic[T]):
    def __init__(
        self,
        ttl_seconds: float,
        max_entries: int,
        max_bytes: int | None = None,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._entries: OrderedDict[str, _Entry[T]] = OrderedDict()
        self._bytes = 0
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> T | None:
        async with self._lock:
            self._remove_expired(time.monotonic())
            entry = self._entries.pop(key, None)
            if entry is None:
                return None
            self._entries[key] = entry
            return entry.value

    async def set(self, key: str, value: T, size: int = 1) -> None:
        safe_size = max(0, size)
        async with self._lock:
            existing = self._entries.pop(key, None)
            if existing is not None:
                self._bytes -= existing.size
            self._entries[key] = _Entry(
                value=value,
                size=safe_size,
                expires_at=time.monotonic() + self.ttl_seconds,
            )
            self._bytes += safe_size
            self._remove_expired(time.monotonic())
            while len(self._entries) > self.max_entries or (
                self.max_bytes is not None and self._bytes > self.max_bytes
            ):
                _oldest_key, oldest = self._entries.popitem(last=False)
                self._bytes -= oldest.size

    async def size(self) -> int:
        async with self._lock:
            self._remove_expired(time.monotonic())
            return len(self._entries)

    async def bytes_used(self) -> int:
        async with self._lock:
            self._remove_expired(time.monotonic())
            return self._bytes

    def _remove_expired(self, now: float) -> None:
        expired = [key for key, entry in self._entries.items() if entry.expires_at <= now]
        for key in expired:
            self._bytes -= self._entries.pop(key).size
