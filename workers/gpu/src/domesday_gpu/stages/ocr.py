"""Stage 5, read text and tags (Part 5).

Reads serial plates, model labels, service tags and existing asset tag numbers,
and decodes QR codes and barcodes (DMS-033, DMS-034). Every value keeps the image
region it was read from: a value with no source region cannot be built (Part 5,
"never guess a number").
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from domesday_gpu.contract import Job, Stage
from domesday_gpu.stages.base import FakeNumbers, SourceRegion


class ReadKind(StrEnum):
    SERIAL = "serial"
    MODEL = "model"
    MANUFACTURE_DATE = "manufacture_date"
    ASSET_TAG = "asset_tag"
    QR_CODE = "qr_code"
    BARCODE = "barcode"


@dataclass(frozen=True, slots=True)
class TextRead:
    kind: ReadKind
    value: str
    confidence: float
    #: Required, never optional: the region of the frame the value was read from.
    source_region: SourceRegion

    def __post_init__(self) -> None:
        if not self.value.strip():
            raise ValueError("an empty read is not a read; leave the field blank instead")
        if not isinstance(self.source_region, SourceRegion):
            raise TypeError("every read value needs the source region it was read from")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0 and 1")

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind.value,
            "value": self.value,
            "confidence": self.confidence,
            "source_region": self.source_region.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class OcrBarcodeResult:
    reads: tuple[TextRead, ...]

    def to_dict(self) -> dict[str, object]:
        return {"reads": [r.to_dict() for r in self.reads]}


class FakeTextReader:
    """Stands in for the OCR model and barcode decoder. It only "reads" label shots, as a real reader mostly would."""

    stage = Stage.READ_TEXT_AND_TAGS

    def __init__(self, model_version: str = "read_text_and_tags@fake-0.0.0") -> None:
        self.model_version = model_version

    def run(self, clip: bytes, job: Job) -> OcrBarcodeResult:
        numbers = FakeNumbers(clip, self.model_version, "ocr")
        reads = []
        for offset in job.label_shot_offsets_ms:
            region = SourceRegion(offset, 0.1 + numbers.next_unit() * 0.4, 0.1 + numbers.next_unit() * 0.4, 0.3, 0.1)
            reads.append(TextRead(ReadKind.SERIAL, f"FAKE-{numbers.next_int(10**8):08d}", 0.6 + numbers.next_unit() * 0.4, region))
        return OcrBarcodeResult(tuple(reads))
