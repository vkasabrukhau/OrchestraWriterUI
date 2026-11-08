"""Score writing from a transcription (server._render), on synthetic notes: no model needed.

    cd ml && uv run python -m unittest discover -s tests      # or: npm run ml:test

A "performance" is a list of tracked beat times (steady or slowing down) with
notes placed exactly on them, so where every bar must start is known.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

VIOLIN, HORN, PIANO, STRINGS, DRUMS = 40, 60, 0, 48, 128
NAMES = {VIOLIN: "violin", HORN: "french horn", PIANO: "acoustic piano", DRUMS: "drums", STRINGS: "program 48"}


def performance(beats: np.ndarray, *, meter: int | None = 4, pickup: bool = True) -> dict:
    """Violin on every beat, horn on every 4th beat from the first, a piano note before beat 1."""
    notes = []
    for i, b in enumerate(beats[:-1]):
        notes.append([VIOLIN, 0, 72, float(b), float(b) + 0.3])
        if i % 4 == 0:
            notes.append([HORN, 0, 60, float(b), float(b) + 0.4])
    if pickup:
        notes.append([PIANO, 0, 55, max(0.0, float(beats[0]) - 0.5), float(beats[0]) - 0.1])
    periods = np.diff(beats)
    return {
        "version": server.TRANSCRIPTION_VERSION,
        "title": "Synthetic",
        "names": {str(k): v for k, v in NAMES.items()},
        "notes": sorted(notes, key=lambda n: n[3]),
        "grid": {
            "bpm": float(60 / periods.mean()),
            "beatsPerBar": meter,
            "firstDownbeat": float(beats[0]),
            "beats": [float(b) for b in beats],
            "onsetDelay": 0.0,
            "beatSubdivision": 1,
            "steady": bool(np.ptp(periods) < 1e-9),
        },
    }


def steady_beats(n: int = 49, period: float = 0.5, first: float = 0.7) -> np.ndarray:
    return first + period * np.arange(n)


def slowing_beats(n: int = 49, first: float = 0.7) -> np.ndarray:
    return first + np.concatenate([[0.0], np.cumsum(np.linspace(0.5, 0.7, n - 1))])


def measure_count(xml: str) -> int:
    first_part = xml.split("<part id=")[1]
    return len(re.findall(r"<measure\b", first_part))


class BarTimes(unittest.TestCase):
    # MuScriptor smooths tracked beats (a parabola through each 9-beat window),
    # which moves the first few of a tempo change by a few ms.
    def assert_bars_on(self, starts: list[float], expected: np.ndarray, tolerance: float = 0.015):
        # the bars before expected[0] hold the pickup; from there, one bar per expected downbeat
        first = int(np.abs(np.asarray(starts) - expected[0]).argmin())
        got = np.asarray(starts[first : first + len(expected)])
        self.assertEqual(len(got), len(expected))
        self.assertLess(float(np.abs(got - expected).max()), tolerance, f"{got[:4]} vs {expected[:4]}")

    def test_steady_performance_bars_start_on_the_downbeats(self):
        beats = steady_beats()
        out = server._render(performance(beats), {})
        self.assert_bars_on(out["measureStarts"], beats[:-1:4])
        self.assertEqual(out["warnings"], [])
        self.assertEqual(len(out["measureStarts"]), measure_count(out["musicxml"]))

    def test_slowing_performance_bars_follow_the_tracked_beats(self):
        beats = slowing_beats()
        out = server._render(performance(beats), {})
        self.assert_bars_on(out["measureStarts"], beats[:-1:4])
        self.assertEqual(out["warnings"], [])

    def test_slowing_performance_keeps_notes_on_the_beat(self):
        out = server._render(performance(slowing_beats(), pickup=False), {})
        # every violin note is a quarter note on a beat: no ties, no 16th rests
        violin = out["musicxml"].split("<part id=")[-1]
        self.assertNotIn("<type>16th</type>", violin)
        self.assertNotIn("<type>32nd</type>", violin)


class Corrections(unittest.TestCase):
    def test_unknown_meter_is_4_4_on_the_tracked_downbeat_with_a_warning(self):
        beats = steady_beats()
        out = server._render(performance(beats, meter=None), {})
        self.assertIn(server.WARN_METER, out["warnings"])
        self.assertEqual(out["beatsPerBar"], 4)
        self.assertEqual(out["detected"]["beatsPerBar"], None)
        BarTimes.assert_bars_on(self, out["measureStarts"], beats[:-1:4])

    def test_setting_the_meter_clears_the_warning(self):
        out = server._render(performance(steady_beats(), meter=None), {"beatsPerBar": 4})
        self.assertNotIn(server.WARN_METER, out["warnings"])

    def test_three_four_writes_three_beat_bars(self):
        beats = steady_beats()
        out = server._render(performance(beats), {"beatsPerBar": 3})
        self.assertIn("<beats>3</beats>", out["musicxml"])
        self.assertEqual(out["bars"]["beatsPerBar"], 3)
        BarTimes.assert_bars_on(self, out["measureStarts"], beats[:-1:3])

    def test_moving_bar_lines_one_beat_later(self):
        beats = slowing_beats()
        out = server._render(performance(beats), {"shiftBeats": 1})
        self.assertEqual(out["bars"]["shiftBeats"], 1)
        BarTimes.assert_bars_on(self, out["measureStarts"], beats[1:-1:4])

    def test_one_beat_earlier_is_three_beats_later_in_four_four(self):
        beats = slowing_beats()
        earlier = server._render(performance(beats), {"shiftBeats": -1})
        later = server._render(performance(beats), {"shiftBeats": 3})
        self.assertEqual(earlier["bars"]["shiftBeats"], 3)
        self.assertEqual(earlier["measureStarts"], later["measureStarts"])
        BarTimes.assert_bars_on(self, earlier["measureStarts"], beats[3:-1:4])

    def test_double_tempo_keeps_the_bar_length_in_seconds(self):
        beats = steady_beats()
        plain = server._render(performance(beats), {})
        double = server._render(performance(beats), {"beatScale": 2})
        self.assertAlmostEqual(double["bpm"], 2 * plain["bpm"], places=1)
        self.assertEqual(double["beatsPerBar"], 8)
        self.assertEqual(double["measureStarts"][:6], plain["measureStarts"][:6])


class Parts(unittest.TestCase):
    def test_names_abbreviations_programs_and_score_order(self):
        out = server._render(performance(steady_beats()), {})
        self.assertEqual(out["parts"], ["Horn", "Piano", "Violin"])
        xml = out["musicxml"]
        self.assertEqual(re.findall(r"<part-abbreviation>(.*?)<", xml), ["Hn.", "Pno.", "Vln."])
        self.assertEqual(re.findall(r"<midi-program>(\d+)<", xml), ["61", "1", "41"])

    def test_drums_keep_their_hits_and_unknown_programs_get_a_group_name(self):
        t = performance(steady_beats(), pickup=False)
        t["notes"] += [[DRUMS, 1, 36, b, b] for b in steady_beats()[:-1]]
        t["notes"] += [[STRINGS, 0, 60, 1.0, 3.0]]
        out = server._render(t, {})
        self.assertIn("Drum Kit", out["parts"])
        self.assertIn("Strings", out["parts"])
        drums = out["musicxml"].split("<part id=")[1 + out["parts"].index("Drum Kit")]
        self.assertGreaterEqual(drums.count("<unpitched>"), 48)


class Warnings(unittest.TestCase):
    def test_notes_off_the_beat_are_flagged_as_approximate(self):
        rng = np.random.default_rng(1)
        t = performance(steady_beats(), pickup=False)
        t["notes"] = sorted(([VIOLIN, 0, 72, float(x), float(x) + 0.2] for x in rng.uniform(0.7, 24, 120)), key=lambda n: n[3])
        t["grid"]["beatSubdivision"] = None
        out = server._render(t, {})
        self.assertIn(server.WARN_LOOSE_RHYTHM, out["warnings"])

    def test_no_beat_grid_uses_the_placeholder_tempo(self):
        t = performance(steady_beats(), meter=None)
        t["grid"] = None
        out = server._render(t, {})
        self.assertEqual(out["bpm"], 120)
        self.assertIn(server.WARN_NO_BEAT, out["warnings"])
        self.assertIn(server.WARN_METER, out["warnings"])


if __name__ == "__main__":
    unittest.main()
