"""Stage 2, privacy pass (Part 5).

Blurs faces, screens and documents in every frame a person or report will see
(DMS-100, DMS-101), and removes the audio track from stored derivatives (DMS-104).
The unblurred original stays in the restricted vault (ADR-DMS-04).
"""

from __future__ import annotations

from dataclasses import dataclass

from domesday_gpu.contract import Job, Stage
from domesday_gpu.stages.base import FakeNumbers


@dataclass(frozen=True, slots=True)
class PrivacyPassResult:
    blurred_uri: str
    faces_blurred: int
    screens_blurred: int
    documents_blurred: int
    audio_removed: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "blurred_uri": self.blurred_uri,
            "faces_blurred": self.faces_blurred,
            "screens_blurred": self.screens_blurred,
            "documents_blurred": self.documents_blurred,
            "audio_removed": self.audio_removed,
        }


class FakePrivacyPass:
    """Stands in for the face and text-region detector during local development."""

    stage = Stage.PRIVACY_PASS

    def __init__(self, model_version: str = "privacy_pass@fake-0.0.0") -> None:
        self.model_version = model_version

    def run(self, clip: bytes, job: Job) -> PrivacyPassResult:
        numbers = FakeNumbers(clip, self.model_version, "privacy")
        return PrivacyPassResult(
            blurred_uri=f"{job.output_prefix}/blurred.mp4",
            faces_blurred=numbers.next_int(4),
            screens_blurred=numbers.next_int(3),
            documents_blurred=numbers.next_int(3),
            audio_removed=True,
        )
