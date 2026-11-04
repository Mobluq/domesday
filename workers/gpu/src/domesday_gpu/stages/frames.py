"""Stage 3, pick frames (Part 5).

Samples frames, drops blurred and near-duplicate ones, and keeps every label shot.
"""

from __future__ import annotations

from dataclasses import dataclass

from domesday_gpu.contract import Job, Stage
from domesday_gpu.stages.base import FakeNumbers


@dataclass(frozen=True, slots=True)
class SelectedFrame:
    time_code_ms: int
    sharpness: float
    is_label_shot: bool
    uri: str

    def to_dict(self) -> dict[str, object]:
        return {
            "time_code_ms": self.time_code_ms,
            "sharpness": self.sharpness,
            "is_label_shot": self.is_label_shot,
            "uri": self.uri,
        }


@dataclass(frozen=True, slots=True)
class FrameSelectionResult:
    frames: tuple[SelectedFrame, ...]

    def to_dict(self) -> dict[str, object]:
        return {"frames": [f.to_dict() for f in self.frames]}


class FakeFrameSelector:
    """Picks a frame every two seconds plus every label shot. Real scoring replaces it after the Phase 0 spike."""

    stage = Stage.PICK_FRAMES

    def __init__(self, model_version: str = "pick_frames@fake-0.0.0", clip_length_ms: int = 60_000) -> None:
        self.model_version = model_version
        self.clip_length_ms = clip_length_ms

    def run(self, clip: bytes, job: Job) -> FrameSelectionResult:
        numbers = FakeNumbers(clip, self.model_version, "frames")
        frames: dict[int, SelectedFrame] = {}
        for time_code in range(0, self.clip_length_ms, 2_000):
            sharpness = numbers.next_unit()
            if sharpness >= 0.3:  # drop blurred frames
                frames[time_code] = SelectedFrame(time_code, sharpness, False, f"{job.output_prefix}/frames/{time_code}.jpg")
        for offset in job.label_shot_offsets_ms:  # every label shot is kept, however sharp
            frames[offset] = SelectedFrame(offset, 1.0, True, f"{job.output_prefix}/label-shots/{offset}.jpg")
        return FrameSelectionResult(tuple(frames[t] for t in sorted(frames)))
