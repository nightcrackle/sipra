from __future__ import annotations

import pytest

from sipra_core.stems import (
    FOUR_STEM_SET,
    SIX_STEM_SET,
    STEM_BY_ID,
    STEM_DEFINITIONS,
    STEM_IDS,
    describe,
    sort_stems,
)


class TestStemVocabulary:
    def test_six_canonical_stems_exist(self):
        assert STEM_IDS == ("vocals", "drums", "bass", "guitar", "piano", "other")

    def test_ids_are_unique(self):
        assert len(set(STEM_IDS)) == len(STEM_IDS)

    def test_display_order_is_contiguous_from_zero(self):
        assert sorted(d.order for d in STEM_DEFINITIONS) == list(range(len(STEM_DEFINITIONS)))

    def test_every_stem_has_a_hex_colour(self):
        for definition in STEM_DEFINITIONS:
            assert definition.color.startswith("#") and len(definition.color) == 7

    def test_colours_are_distinct(self):
        """Two lanes sharing a colour would be unreadable in the workspace."""
        colours = [d.color for d in STEM_DEFINITIONS]
        assert len(set(colours)) == len(colours)

    def test_the_four_stem_set_is_a_subset_of_the_six(self):
        assert set(FOUR_STEM_SET) < set(SIX_STEM_SET)

    def test_guitar_and_piano_are_the_experimental_pair(self):
        """These are the two the 6-stem model is weakest at, and the UI
        needs to say so rather than implying six equal lanes."""
        experimental = {d.id for d in STEM_DEFINITIONS if d.experimental}
        assert experimental == {"guitar", "piano"}

    def test_every_experimental_stem_explains_itself(self):
        for definition in STEM_DEFINITIONS:
            if definition.experimental:
                assert len(definition.note) > 20


class TestSortStems:
    def test_orders_by_the_canonical_display_order(self):
        assert sort_stems(["other", "vocals", "bass"]) == ["vocals", "bass", "other"]

    def test_unknown_ids_are_appended_not_dropped(self):
        assert sort_stems(["mystery", "vocals"]) == ["vocals", "mystery"]

    def test_an_empty_list_stays_empty(self):
        assert sort_stems([]) == []

    def test_accepts_a_tuple(self):
        assert sort_stems(("drums", "vocals")) == ["vocals", "drums"]


class TestDescribe:
    def test_returns_ui_metadata_in_order(self):
        described = describe(["piano", "vocals"])
        assert [d["id"] for d in described] == ["vocals", "piano"]
        assert set(described[0]) == {"id", "label", "color", "order", "experimental", "note"}

    def test_covers_every_stem(self):
        assert len(describe(list(STEM_IDS))) == len(STEM_IDS)

    @pytest.mark.parametrize("stem_id", STEM_IDS)
    def test_each_stem_has_a_human_label(self, stem_id):
        assert STEM_BY_ID[stem_id].label[0].isupper()
