"""Domesday GPU worker pool (ADR-DMS-02).

Runs pipeline stages 2 to 5: privacy pass, pick frames, detect and track, and
read text and tags. Workers hold no business data: they pull a job, read a clip,
write results and exit.
"""

from domesday_gpu.contract import (
    ClipReader,
    ConflictingResultError,
    Job,
    JobKey,
    JobSource,
    ModelVersionMismatchError,
    ResultSink,
    Stage,
    StageDisabledError,
    StageResult,
)
from domesday_gpu.registry import StageRegistry, fake_registry
from domesday_gpu.worker import RunOutcome, run_once

__all__ = [
    "ClipReader",
    "ConflictingResultError",
    "Job",
    "JobKey",
    "JobSource",
    "ModelVersionMismatchError",
    "ResultSink",
    "RunOutcome",
    "Stage",
    "StageDisabledError",
    "StageRegistry",
    "StageResult",
    "fake_registry",
    "run_once",
]
