"""The worker: pull a job, read a clip, write results, exit (PRD Part 6).

Run one job against in-memory fakes:  python -m domesday_gpu --demo
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass

from domesday_gpu.contract import (
    ClipReader,
    Job,
    JobSource,
    ModelVersionMismatchError,
    ResultSink,
    Stage,
    StageDisabledError,
)
from domesday_gpu.registry import StageRegistry, fake_registry


@dataclass(frozen=True, slots=True)
class RunOutcome:
    status: str  # "idle", "done", "duplicate" or "failed"
    job_key: str | None = None
    error: str | None = None


def run_once(source: JobSource, reader: ClipReader, sink: ResultSink, registry: StageRegistry) -> RunOutcome:
    """Handle at most one job. Safe to repeat: a job whose result already exists is acknowledged, not redone."""
    job = source.lease()
    if job is None:
        return RunOutcome("idle")
    key = str(job.key)

    if sink.has(job.key):
        source.complete(job.job_id)
        return RunOutcome("duplicate", key)

    try:
        runner = registry.get(job.key.stage)
        if runner.model_version != job.key.model_version:
            raise ModelVersionMismatchError(
                f"job wants {job.key.model_version}, this worker runs {runner.model_version}",
            )
    except (StageDisabledError, ModelVersionMismatchError) as error:
        # Retrying on this worker cannot help, so the job goes back for routing or the dead-letter queue.
        source.fail(job.job_id, error=str(error), retryable=False)
        return RunOutcome("failed", key, str(error))

    try:
        clip = reader.read(job.input_uri)
        result = runner.run(clip, job)
        sink.write(job.key, result)
    except Exception as error:  # noqa: BLE001 - any stage failure is reported and retried with backoff by the API
        source.fail(job.job_id, error=f"{type(error).__name__}: {error}", retryable=True)
        return RunOutcome("failed", key, str(error))

    source.complete(job.job_id)
    return RunOutcome("done", key)


def _demo() -> RunOutcome:
    from domesday_gpu.contract import JobKey
    from domesday_gpu.fakes import InMemoryClipReader, InMemoryJobSource, InMemoryResultSink

    source = InMemoryJobSource()
    reader = InMemoryClipReader({"memory://clip": b"demo clip bytes"})
    sink = InMemoryResultSink()
    source.add(
        Job(
            job_id="job-1",
            key=JobKey("00000000-0000-4000-8000-000000000001", Stage.PRIVACY_PASS, "privacy_pass@fake-0.0.0"),
            input_uri="memory://clip",
            output_prefix="memory://derived/clip-1",
        )
    )
    outcome = run_once(source, reader, sink, fake_registry())
    print(json.dumps({"outcome": outcome.status, "job_key": outcome.job_key, "results": sink.results}, indent=2))
    return outcome


def main() -> None:
    parser = argparse.ArgumentParser(description="Domesday GPU worker")
    parser.add_argument("--demo", action="store_true", help="run one job against in-memory fakes and print the result")
    args = parser.parse_args()
    if not args.demo:
        parser.error("only --demo is available: the job source that talks to the API is not built yet")
    _demo()


if __name__ == "__main__":
    main()
