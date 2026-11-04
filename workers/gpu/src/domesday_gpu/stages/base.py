"""Types shared by the stage modules, and a deterministic source of fake numbers."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol, TypeVar

from domesday_gpu.contract import Job, Stage, StageResult

ResultT_co = TypeVar("ResultT_co", bound=StageResult, covariant=True)


class StageRunner(Protocol[ResultT_co]):
    """One GPU stage. The model version is pinned; the same input and version always give the same result."""

    stage: Stage
    model_version: str

    def run(self, clip: bytes, job: Job) -> ResultT_co: ...


@dataclass(frozen=True, slots=True)
class SourceRegion:
    """The image region a value was read from, each number a share of the frame from 0 to 1."""

    time_code_ms: int
    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        if self.time_code_ms < 0:
            raise ValueError("time_code_ms must be zero or more")
        for name in ("x", "y", "width", "height"):
            value = getattr(self, name)
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be between 0 and 1")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("a source region needs a width and a height")

    def to_dict(self) -> dict[str, object]:
        return {
            "time_code_ms": self.time_code_ms,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


class FakeNumbers:
    """Deterministic pseudo-random numbers from the clip bytes and model version, for the fake stages.

    No machine learning models are downloaded or run: these fakes only give later
    stages realistic shapes to work with during local development.
    """

    def __init__(self, clip: bytes, model_version: str, salt: str) -> None:
        self._seed = hashlib.sha256(clip + model_version.encode() + salt.encode()).digest()
        self._counter = 0

    def next_int(self, upper: int) -> int:
        """A whole number from 0 up to, but not including, upper."""
        self._counter += 1
        block = hashlib.sha256(self._seed + self._counter.to_bytes(8, "big")).digest()
        return int.from_bytes(block[:8], "big") % upper

    def next_unit(self) -> float:
        """A number from 0 up to, but not including, 1, in steps of 0.001."""
        return self.next_int(1000) / 1000.0
