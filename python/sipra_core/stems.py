"""Canonical stem vocabulary.

The same six ids appear in the Python core, the Electron main process and
the renderer. ``shared/stems.ts`` is the TypeScript mirror of this file
and the two are kept in sync by a test.
"""

from __future__ import annotations

from dataclasses import dataclass

VOCALS = "vocals"
DRUMS = "drums"
BASS = "bass"
GUITAR = "guitar"
PIANO = "piano"
OTHER = "other"


@dataclass(frozen=True)
class StemDefinition:
    id: str
    label: str
    color: str
    order: int
    experimental: bool = False
    note: str = ""


STEM_DEFINITIONS: tuple[StemDefinition, ...] = (
    StemDefinition(VOCALS, "Vocals", "#FF6B4A", 0),
    StemDefinition(DRUMS, "Drums", "#FFB020", 1),
    StemDefinition(BASS, "Bass", "#7C5CFF", 2),
    StemDefinition(
        GUITAR,
        "Guitar",
        "#2ECC71",
        3,
        experimental=True,
        note="Separated only by the 6-stem model. Usable, but expect some bleed.",
    ),
    StemDefinition(
        PIANO,
        "Piano",
        "#35B7FF",
        4,
        experimental=True,
        note=(
            "The weakest source in the 6-stem model. Demucs' own documentation "
            "reports heavy bleeding and artefacts here. Treat it as a rough guide."
        ),
    ),
    StemDefinition(OTHER, "Other", "#9AA3B2", 5),
)

STEM_IDS: tuple[str, ...] = tuple(d.id for d in STEM_DEFINITIONS)
STEM_BY_ID: dict[str, StemDefinition] = {d.id: d for d in STEM_DEFINITIONS}

FOUR_STEM_SET: tuple[str, ...] = (VOCALS, DRUMS, BASS, OTHER)
SIX_STEM_SET: tuple[str, ...] = (VOCALS, DRUMS, BASS, GUITAR, PIANO, OTHER)


def sort_stems(ids: list[str] | tuple[str, ...]) -> list[str]:
    """Return ``ids`` in canonical display order; unknown ids go last."""
    known = [i for i in ids if i in STEM_BY_ID]
    unknown = [i for i in ids if i not in STEM_BY_ID]
    known.sort(key=lambda i: STEM_BY_ID[i].order)
    return known + sorted(unknown)


def describe(ids: list[str] | tuple[str, ...]) -> list[dict]:
    """Serialisable stem metadata for the UI."""
    return [
        {
            "id": d.id,
            "label": d.label,
            "color": d.color,
            "order": d.order,
            "experimental": d.experimental,
            "note": d.note,
        }
        for d in (STEM_BY_ID[i] for i in sort_stems(list(ids)))
    ]
