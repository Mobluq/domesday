"""Which implementation runs each stage, and which stages are switched off."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from domesday_gpu.contract import Stage, StageDisabledError, StageResult
from domesday_gpu.stages import FakeDetectorTracker, FakeFrameSelector, FakePrivacyPass, FakeTextReader, StageRunner


class StageRegistry:
    def __init__(self, runners: Mapping[Stage, StageRunner[StageResult]], disabled: Iterable[Stage] = ()) -> None:
        self._runners = dict(runners)
        self._disabled = frozenset(disabled)

    def get(self, stage: Stage) -> StageRunner[StageResult]:
        """The runner for a stage. Part 5 kill switches: a disabled stage refuses work."""
        if stage in self._disabled:
            raise StageDisabledError(f"{stage.value} is switched off")
        runner = self._runners.get(stage)
        if runner is None:
            raise StageDisabledError(f"no runner for {stage.value}")
        return runner


def fake_registry(disabled: Iterable[Stage] = ()) -> StageRegistry:
    """Every stage backed by its fake. No machine learning models are downloaded."""
    runners: dict[Stage, StageRunner[StageResult]] = {
        Stage.PRIVACY_PASS: FakePrivacyPass(),
        Stage.PICK_FRAMES: FakeFrameSelector(),
        Stage.DETECT_AND_TRACK: FakeDetectorTracker(),
        Stage.READ_TEXT_AND_TAGS: FakeTextReader(),
    }
    return StageRegistry(runners, disabled)
