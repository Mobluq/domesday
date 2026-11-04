"""In-memory job queue, clip reader and result sink for tests and local development."""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field

from domesday_gpu.contract import ConflictingResultError, Job, JobKey, StageResult


@dataclass
class InMemoryJobSource:
    queue: deque[Job] = field(default_factory=deque)
    completed: list[str] = field(default_factory=list)
    failed: list[tuple[str, str, bool]] = field(default_factory=list)

    def add(self, job: Job) -> None:
        self.queue.append(job)

    def lease(self) -> Job | None:
        return self.queue.popleft() if self.queue else None

    def complete(self, job_id: str) -> None:
        self.completed.append(job_id)

    def fail(self, job_id: str, *, error: str, retryable: bool) -> None:
        self.failed.append((job_id, error, retryable))


@dataclass
class InMemoryClipReader:
    clips: dict[str, bytes] = field(default_factory=dict)
    reads: int = 0

    def read(self, uri: str) -> bytes:
        self.reads += 1
        try:
            return self.clips[uri]
        except KeyError:
            raise FileNotFoundError(uri) from None


@dataclass
class InMemoryResultSink:
    results: dict[str, str] = field(default_factory=dict)

    def has(self, key: JobKey) -> bool:
        return str(key) in self.results

    def write(self, key: JobKey, result: StageResult) -> None:
        """DMS-042: the same key with the same result is a no-op; a different result is a determinism bug."""
        encoded = json.dumps(result.to_dict(), sort_keys=True)
        existing = self.results.get(str(key))
        if existing is not None and existing != encoded:
            raise ConflictingResultError(f"{key} produced a different result on a repeat run")
        self.results[str(key)] = encoded
