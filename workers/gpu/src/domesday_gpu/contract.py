"""The job contract between the API's processing module and the GPU worker pool.

PRD Part 6 and ADR-DMS-02: GPU workers run apart from the monolith because they
need GPUs and Python machine learning libraries. They hold no business data of
their own: a worker pulls a job, reads a clip, writes results and exits.

So a Job carries identifiers, storage locations and the pinned model version,
and nothing else: no tenant name, no site, no register values, no people.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol


class Stage(StrEnum):
    """The pipeline stages that run on GPU workers (Part 5, stages 2 to 5)."""

    PRIVACY_PASS = "privacy_pass"
    PICK_FRAMES = "pick_frames"
    DETECT_AND_TRACK = "detect_and_track"
    READ_TEXT_AND_TAGS = "read_text_and_tags"


@dataclass(frozen=True, slots=True)
class JobKey:
    """DMS-042: every job is keyed by clip, stage and model version, so a repeat is harmless."""

    clip_id: str
    stage: Stage
    model_version: str

    def __post_init__(self) -> None:
        if not self.clip_id or not self.model_version:
            raise ValueError("a job key needs a clip ID and a model version")

    def __str__(self) -> str:
        return f"{self.clip_id}:{self.stage.value}:{self.model_version}"


@dataclass(frozen=True, slots=True)
class Job:
    """One unit of work. Identifiers and storage locations only."""

    job_id: str
    key: JobKey
    #: Where to read the input: the original clip for the privacy pass, the previous stage's output after that.
    input_uri: str
    #: Where to write derived files (blurred frames, crops).
    output_prefix: str
    attempt: int = 1
    #: Moments in the clip where the user took a label shot (DMS-015). Stage 3 keeps every one.
    label_shot_offsets_ms: tuple[int, ...] = ()


class StageResult(Protocol):
    """Every stage result can be written as JSON-ready data."""

    def to_dict(self) -> dict[str, object]: ...


class JobSource(Protocol):
    """Where jobs come from. In production, the API's processing module; locally, an in-memory queue."""

    def lease(self) -> Job | None: ...

    def complete(self, job_id: str) -> None: ...

    def fail(self, job_id: str, *, error: str, retryable: bool) -> None: ...


class ClipReader(Protocol):
    """Reads a clip or a previous stage's output through a short-lived signed URL."""

    def read(self, uri: str) -> bytes: ...


class ResultSink(Protocol):
    """Where results go. Writing the same key twice with the same result is harmless (DMS-042)."""

    def has(self, key: JobKey) -> bool: ...

    def write(self, key: JobKey, result: StageResult) -> None: ...


class ConflictingResultError(RuntimeError):
    """The same job key produced a different result: a stage is not deterministic for its model version."""


class StageDisabledError(RuntimeError):
    """The stage is switched off (the per-tenant kill switch in Part 5)."""


class ModelVersionMismatchError(RuntimeError):
    """The job asks for a model version this worker does not run. Results are never written under another version."""
