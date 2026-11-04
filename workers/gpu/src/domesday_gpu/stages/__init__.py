"""The four GPU stages, each with a typed interface and a fake for local development."""

from domesday_gpu.stages.base import FakeNumbers, SourceRegion, StageRunner
from domesday_gpu.stages.detect_track import Box, DetectTrackResult, FakeDetectorTracker, Track
from domesday_gpu.stages.frames import FakeFrameSelector, FrameSelectionResult, SelectedFrame
from domesday_gpu.stages.ocr import FakeTextReader, OcrBarcodeResult, ReadKind, TextRead
from domesday_gpu.stages.privacy import FakePrivacyPass, PrivacyPassResult

__all__ = [
    "Box",
    "DetectTrackResult",
    "FakeDetectorTracker",
    "FakeFrameSelector",
    "FakeNumbers",
    "FakePrivacyPass",
    "FakeTextReader",
    "FrameSelectionResult",
    "OcrBarcodeResult",
    "PrivacyPassResult",
    "ReadKind",
    "SelectedFrame",
    "SourceRegion",
    "StageRunner",
    "TextRead",
    "Track",
]
