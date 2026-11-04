"""Stage 4, detect and track (Part 5).

Finds candidate assets and follows each across frames, so the same item seen in
many frames is counted once (DMS-031).
"""

from __future__ import annotations

from dataclasses import dataclass

from domesday_gpu.contract import Job, Stage
from domesday_gpu.stages.base import FakeNumbers


@dataclass(frozen=True, slots=True)
class Box:
    time_code_ms: int
    x: float
    y: float
    width: float
    height: float
    score: float

    def to_dict(self) -> dict[str, object]:
        return {
            "time_code_ms": self.time_code_ms,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "score": self.score,
        }


@dataclass(frozen=True, slots=True)
class Track:
    track_key: str
    #: A hint only. Stage 6 picks the category from the tenant's own list.
    category_hint: str
    first_seen_ms: int
    last_seen_ms: int
    boxes: tuple[Box, ...]

    def __post_init__(self) -> None:
        if not self.boxes:
            raise ValueError("a track is seen in at least one frame")
        if self.last_seen_ms < self.first_seen_ms:
            raise ValueError("a track cannot end before it starts")

    @property
    def frame_count(self) -> int:
        return len(self.boxes)

    def to_dict(self) -> dict[str, object]:
        return {
            "track_key": self.track_key,
            "category_hint": self.category_hint,
            "first_seen_ms": self.first_seen_ms,
            "last_seen_ms": self.last_seen_ms,
            "frame_count": self.frame_count,
            "boxes": [b.to_dict() for b in self.boxes],
        }


@dataclass(frozen=True, slots=True)
class DetectTrackResult:
    tracks: tuple[Track, ...]

    def to_dict(self) -> dict[str, object]:
        return {"tracks": [t.to_dict() for t in self.tracks]}


_FAKE_HINTS = ("generator", "split_air_conditioner", "fire_extinguisher", "desk", "chair", "laptop")


class FakeDetectorTracker:
    """Stands in for the open-vocabulary detector and multi-object tracker during local development."""

    stage = Stage.DETECT_AND_TRACK

    def __init__(self, model_version: str = "detect_and_track@fake-0.0.0") -> None:
        self.model_version = model_version

    def run(self, clip: bytes, job: Job) -> DetectTrackResult:
        numbers = FakeNumbers(clip, self.model_version, "tracks")
        tracks = []
        for index in range(1 + numbers.next_int(5)):
            start = numbers.next_int(50) * 1_000
            seen = 1 + numbers.next_int(4)
            boxes = tuple(
                Box(start + i * 1_000, numbers.next_unit() * 0.5, numbers.next_unit() * 0.5, 0.2, 0.2, 0.5 + numbers.next_unit() / 2)
                for i in range(seen)
            )
            tracks.append(
                Track(
                    track_key=f"t{index}",
                    category_hint=_FAKE_HINTS[numbers.next_int(len(_FAKE_HINTS))],
                    first_seen_ms=boxes[0].time_code_ms,
                    last_seen_ms=boxes[-1].time_code_ms,
                    boxes=boxes,
                )
            )
        return DetectTrackResult(tuple(tracks))
