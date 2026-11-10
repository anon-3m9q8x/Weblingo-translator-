"""In-memory rate limiting and daily budgets (no database required).

Counters live in the server process, so they reset when it restarts and are not
shared between multiple instances. Run a single instance, or put a shared limiter
(e.g. at the reverse proxy) in front when scaling out.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone


class RateLimiter:
    """Sliding-window limiter: at most `limit` events per `window` seconds per key."""

    def __init__(self, limit: int, window: float) -> None:
        self.limit = limit
        self.window = window
        self._events: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> float:
        """Record one event. Returns 0 if allowed, otherwise seconds until retry."""
        if self.limit <= 0:
            return 0.0
        now = time.monotonic()
        with self._lock:
            events = self._events.setdefault(key, deque())
            while events and now - events[0] >= self.window:
                events.popleft()
            if len(events) >= self.limit:
                return max(1.0, self.window - (now - events[0]))
            events.append(now)
            if len(self._events) > 20000:
                self._prune(now)
            return 0.0

    def _prune(self, now: float) -> None:
        for key in [k for k, v in self._events.items() if not v or now - v[-1] >= self.window]:
            self._events.pop(key, None)


class DailyBudget:
    """Server-wide character budget that resets at 00:00 UTC."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._day = ''
        self._used = 0
        self._lock = threading.Lock()

    def _roll(self) -> None:
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        if today != self._day:
            self._day, self._used = today, 0

    def consume(self, amount: int) -> bool:
        if self.limit <= 0:
            return True
        with self._lock:
            self._roll()
            if self._used + amount > self.limit:
                return False
            self._used += amount
            return True

    def refund(self, amount: int) -> None:
        with self._lock:
            self._used = max(0, self._used - amount)

    def remaining(self) -> int | None:
        if self.limit <= 0:
            return None
        with self._lock:
            self._roll()
            return max(0, self.limit - self._used)
