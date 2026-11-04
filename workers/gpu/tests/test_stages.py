"""The fake stages: typed results, deterministic output, and the rules each stage must keep."""

from __future__ import annotations

import pytest

from domesday_gpu import Job, JobKey, Stage
from domesday_gpu.stages import (
    FakeDetectorTracker,
    FakeFrameSelector,
    FakePrivacyPass,
    FakeTextReader,
    ReadKind,
    SourceRegion,
    TextRead,
    Track,
)

CLIP_ID = "22222222-2222-4222-8222-222222222222"
CLIP = b"some clip bytes" * 100


def job(stage: Stage, version: str, label_shots: tuple[int, ...] = ()) -> Job:
    return Job("j", JobKey(CLIP_ID, stage, version), "memory://in", "memory://out", 1, label_shots)


def test_every_fake_is_deterministic_for_its_model_version() -> None:
    """DMS-042: the same input and model version give the same output."""
    runners = [FakePrivacyPass(), FakeFrameSelector(), FakeDetectorTracker(), FakeTextReader()]
    for runner in runners:
        j = job(runner.stage, runner.model_version, (3_100, 41_500))
        assert runner.run(CLIP, j).to_dict() == runner.run(CLIP, j).to_dict()


def test_privacy_pass_blurs_and_removes_audio() -> None:
    """DMS-100, DMS-101, DMS-104."""
    result = FakePrivacyPass().run(CLIP, job(Stage.PRIVACY_PASS, "privacy_pass@fake-0.0.0"))
    assert result.audio_removed is True
    assert result.blurred_uri == "memory://out/blurred.mp4"
    assert min(result.faces_blurred, result.screens_blurred, result.documents_blurred) >= 0


def test_frame_selection_keeps_every_label_shot() -> None:
    """Part 5, stage 3: drops blurred frames but keeps every label shot."""
    shots = (1_234, 5_678, 59_999)
    result = FakeFrameSelector().run(CLIP, job(Stage.PICK_FRAMES, "pick_frames@fake-0.0.0", shots))
    kept = {f.time_code_ms for f in result.frames if f.is_label_shot}
    assert kept == set(shots)
    assert all(f.sharpness >= 0.3 for f in result.frames)
    assert [f.time_code_ms for f in result.frames] == sorted(f.time_code_ms for f in result.frames)


def test_tracks_are_seen_in_at_least_one_frame() -> None:
    """DMS-031: one track per item, counted once however many frames it appears in."""
    result = FakeDetectorTracker().run(CLIP, job(Stage.DETECT_AND_TRACK, "detect_and_track@fake-0.0.0"))
    assert result.tracks
    assert len({t.track_key for t in result.tracks}) == len(result.tracks)
    assert all(t.frame_count >= 1 and t.last_seen_ms >= t.first_seen_ms for t in result.tracks)
    with pytest.raises(ValueError):
        Track("t", "desk", 10, 5, ())


def test_every_read_value_keeps_its_source_region() -> None:
    """Part 5 and DMS-033: serial, model and tag numbers come only from text actually read."""
    result = FakeTextReader().run(CLIP, job(Stage.READ_TEXT_AND_TAGS, "read_text_and_tags@fake-0.0.0", (2_000, 9_000)))
    assert len(result.reads) == 2
    assert all(isinstance(r.source_region, SourceRegion) for r in result.reads)
    assert {r.source_region.time_code_ms for r in result.reads} == {2_000, 9_000}


def test_a_read_without_a_source_region_cannot_be_built() -> None:
    with pytest.raises(TypeError):
        TextRead(ReadKind.SERIAL, "SN-1", 0.9, None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        TextRead(ReadKind.SERIAL, "   ", 0.9, SourceRegion(0, 0.1, 0.1, 0.2, 0.2))
    with pytest.raises(ValueError):
        SourceRegion(0, 0.9, 0.1, 1.5, 0.2)
    with pytest.raises(ValueError):
        SourceRegion(0, 0.1, 0.1, 0.0, 0.2)


def test_no_reads_without_label_shots() -> None:
    """Never guess a number: with nothing read, the field stays blank."""
    assert FakeTextReader().run(CLIP, job(Stage.READ_TEXT_AND_TAGS, "read_text_and_tags@fake-0.0.0")).reads == ()
