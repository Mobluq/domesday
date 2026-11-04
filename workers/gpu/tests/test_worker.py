"""The job contract and the run-once worker loop."""

from __future__ import annotations

import dataclasses

import pytest

from domesday_gpu import Job, JobKey, Stage, fake_registry, run_once
from domesday_gpu.contract import ConflictingResultError
from domesday_gpu.fakes import InMemoryClipReader, InMemoryJobSource, InMemoryResultSink
from domesday_gpu.registry import StageRegistry
from domesday_gpu.stages import FakePrivacyPass, PrivacyPassResult

CLIP = "11111111-1111-4111-8111-111111111111"


def make_job(job_id: str = "job-1", stage: Stage = Stage.PRIVACY_PASS, version: str = "privacy_pass@fake-0.0.0") -> Job:
    return Job(job_id=job_id, key=JobKey(CLIP, stage, version), input_uri="memory://clip", output_prefix="memory://out")


@pytest.fixture()
def env() -> tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink]:
    return InMemoryJobSource(), InMemoryClipReader({"memory://clip": b"clip bytes"}), InMemoryResultSink()


def test_job_key_is_clip_stage_and_model_version() -> None:
    key = JobKey(CLIP, Stage.DETECT_AND_TRACK, "detect_and_track@1.2.0")
    assert str(key) == f"{CLIP}:detect_and_track:detect_and_track@1.2.0"
    assert key == JobKey(CLIP, Stage.DETECT_AND_TRACK, "detect_and_track@1.2.0")
    assert len({key, JobKey(CLIP, Stage.DETECT_AND_TRACK, "detect_and_track@1.2.0")}) == 1
    with pytest.raises(ValueError):
        JobKey("", Stage.PRIVACY_PASS, "v1")


def test_a_job_holds_no_business_data() -> None:
    """Part 6: workers hold no business data. A job is identifiers, storage locations and versions only."""
    assert [f.name for f in dataclasses.fields(Job)] == [
        "job_id",
        "key",
        "input_uri",
        "output_prefix",
        "attempt",
        "label_shot_offsets_ms",
    ]
    assert [f.name for f in dataclasses.fields(JobKey)] == ["clip_id", "stage", "model_version"]


def test_only_gpu_stages_run_here() -> None:
    assert [s.value for s in Stage] == ["privacy_pass", "pick_frames", "detect_and_track", "read_text_and_tags"]


def test_pull_a_job_read_a_clip_write_results_exit(env: tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink]) -> None:
    source, reader, sink = env
    source.add(make_job())
    outcome = run_once(source, reader, sink, fake_registry())
    assert outcome.status == "done"
    assert source.completed == ["job-1"]
    assert sink.has(make_job().key)
    assert run_once(source, reader, sink, fake_registry()).status == "idle"


def test_dms_042_a_repeated_job_is_harmless(env: tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink]) -> None:
    source, reader, sink = env
    source.add(make_job("job-1"))
    source.add(make_job("job-1-retry"))
    assert run_once(source, reader, sink, fake_registry()).status == "done"
    assert run_once(source, reader, sink, fake_registry()).status == "duplicate"
    assert reader.reads == 1
    assert len(sink.results) == 1
    assert source.completed == ["job-1", "job-1-retry"]


def test_dms_042_the_sink_refuses_a_different_result_for_the_same_key() -> None:
    sink = InMemoryResultSink()
    key = make_job().key
    first = PrivacyPassResult("memory://out/blurred.mp4", 1, 0, 0, True)
    sink.write(key, first)
    sink.write(key, first)
    with pytest.raises(ConflictingResultError):
        sink.write(key, PrivacyPassResult("memory://out/blurred.mp4", 2, 0, 0, True))


def test_results_are_never_written_under_another_model_version(
    env: tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink],
) -> None:
    source, reader, sink = env
    source.add(make_job(version="privacy_pass@9.9.9"))
    outcome = run_once(source, reader, sink, fake_registry())
    assert outcome.status == "failed"
    assert sink.results == {}
    assert source.failed[0][2] is False  # not retryable on this worker


def test_a_switched_off_stage_refuses_work(env: tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink]) -> None:
    source, reader, sink = env
    source.add(make_job())
    outcome = run_once(source, reader, sink, fake_registry(disabled=[Stage.PRIVACY_PASS]))
    assert outcome.status == "failed"
    assert "switched off" in (outcome.error or "")
    assert sink.results == {}


def test_a_stage_failure_is_reported_for_retry(env: tuple[InMemoryJobSource, InMemoryClipReader, InMemoryResultSink]) -> None:
    source, _, sink = env
    source.add(make_job())
    outcome = run_once(source, InMemoryClipReader({}), sink, fake_registry())
    assert outcome.status == "failed"
    assert source.failed == [("job-1", "FileNotFoundError: memory://clip", True)]
    assert sink.results == {}


def test_registry_without_a_runner_refuses() -> None:
    registry = StageRegistry({Stage.PRIVACY_PASS: FakePrivacyPass()})
    source = InMemoryJobSource()
    source.add(make_job(stage=Stage.PICK_FRAMES, version="pick_frames@fake-0.0.0"))
    outcome = run_once(source, InMemoryClipReader({"memory://clip": b"x"}), InMemoryResultSink(), registry)
    assert outcome.status == "failed"
