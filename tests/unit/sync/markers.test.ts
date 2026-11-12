import { describe, expect, it } from "vitest";
import {
  MARKER_LABEL_MAX,
  MIN_ALIGNMENT_GAP,
  markerBounds,
  mergeAlignment,
  mergeAlignmentDetailed,
  normalizeMarkerLabel,
  parseSyncState,
  pendingBars,
  pendingOf,
  resolveRange,
  SyncShapeError,
  type ManualMarker,
  type MeasureAlignment,
} from "@/shared/sync";

const auto: MeasureAlignment[] = [1, 3, 5, 7, 9, 11].map((startSec, i) => ({ n: i + 1, startSec, confidence: 58 }));
const mk = (id: string, measure: number, startSec: number, position?: number, extra: Partial<ManualMarker> = {}): ManualMarker => ({
  id,
  measure,
  startSec,
  createdAt: "2026-11-09T00:00:00.000Z",
  basis: "time",
  ...(position ? { position } : {}),
  ...extra,
});

describe("marker labels", () => {
  it("keeps 79 characters plus an emoji whole and cuts past 80 code points", () => {
    const s = `${"a".repeat(79)}🎻`;
    expect(normalizeMarkerLabel(s)).toBe(s);
    expect(Array.from(normalizeMarkerLabel(`${s}xyz`)!).length).toBe(MARKER_LABEL_MAX);
    expect(normalizeMarkerLabel("   ")).toBeUndefined();
    expect(normalizeMarkerLabel(4)).toBeUndefined();
  });
});

describe("merge", () => {
  it("copies confidence from the aligner: markers never change it", () => {
    expect(mergeAlignment(auto, [mk("a", 3, 5.4)]).map((a) => a.confidence)).toEqual(auto.map((a) => a.confidence));
  });

  it("keeps every anchor where it was put when there is room", () => {
    const { aligned, finals, unhonoured } = mergeAlignmentDetailed(auto, [mk("a", 2, 3.2), mk("b", 4, 7.1)]);
    expect(finals.get("a")).toBe(3.2);
    expect(finals.get("b")).toBe(7.1);
    expect(unhonoured).toEqual([]);
    expect(aligned[1].startSec).toBe(3.2);
  });

  it("property: any mix of anchors merges strictly increasing by at least the gap and lists the ones it had to push", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 300; trial++) {
      const markers: ManualMarker[] = [];
      const count = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < count; k++) markers.push(mk(`m${k}`, 1 + Math.floor(rnd() * 6), rnd() * 14, rnd() < 0.5 ? undefined : 0.1 + rnd() * 0.8));
      const { aligned, finals, unhonoured } = mergeAlignmentDetailed(auto, markers);
      const knots: number[] = [];
      for (const a of aligned) {
        knots.push(a.startSec);
        for (const p of a.points ?? []) knots.push(p.sec);
      }
      for (let i = 1; i < knots.length; i++) expect(knots[i] - knots[i - 1]).toBeGreaterThanOrEqual(MIN_ALIGNMENT_GAP - 1e-9);
      const spot = (m: ManualMarker) => `${m.measure}:${m.position ?? 0}`;
      for (const m of markers) {
        // two markers on one note: the later one is the anchor
        if (markers.filter((o) => spot(o) === spot(m)).length > 1) continue;
        const f = finals.get(m.id);
        if (f !== undefined && !unhonoured.includes(m.id)) expect(f).toBeCloseTo(m.startSec, 9);
      }
    }
  });

  it("property: any time inside markerBounds is the merged anchor time", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 300; trial++) {
      const others = [mk("x", 2, 2 + rnd() * 3), mk("y", 5, 8 + rnd() * 3, 0.5)];
      const measure = 1 + Math.floor(rnd() * 6);
      const position = rnd() < 0.5 ? 0 : 0.25;
      const { low, high } = markerBounds(auto, others, { measure, position }, { durationSec: 20 });
      if (high < low) continue;
      const t = low + rnd() * (high - low);
      const m = mk("new", measure, t, position || undefined);
      const { finals, unhonoured } = mergeAlignmentDetailed(auto, [...others.filter((o) => !(o.measure === measure && (o.position ?? 0) === position)), m]);
      if (unhonoured.length === 0) expect(finals.get("new")).toBeCloseTo(t, 9);
      else expect(unhonoured).not.toContain("new");
    }
  });

  it("bounds an edit by its neighbours with room for the knots between", () => {
    const { low, high } = markerBounds(auto, [mk("a", 2, 3), mk("b", 5, 9)], { measure: 3 }, { durationSec: 20 });
    expect(low).toBeCloseTo(3 + MIN_ALIGNMENT_GAP);
    expect(high).toBeCloseTo(9 - 2 * MIN_ALIGNMENT_GAP);
  });
});

describe("pending and applied markers", () => {
  const applied = [mk("a", 2, 3.1), mk("b", 4, 7.2)];

  it("derives new, moved and deleted items by id; a label-only change is not pending", () => {
    const manual = [mk("a", 2, 3.1, undefined, { label: "Horns" }), mk("c", 5, 9.3), { ...mk("b", 4, 7.5) }];
    const items = pendingOf(manual, applied);
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["c", "new"],
      ["b", "moved"],
    ]);
    expect(pendingOf([mk("a", 2, 3.1)], applied).map((i) => [i.id, i.kind])).toEqual([["b", "deleted"]]);
    expect([...pendingBars(pendingOf([mk("b", 6, 11.2)], [mk("b", 4, 7.2)]))].sort()).toEqual([4, 6]);
  });

  it("a recompute over a range applies only items whose bars all lie inside it", () => {
    const manual = [mk("a", 2, 3.3), mk("b", 6, 11.3)]; // a moved in bar 2; b moved from bar 4 to 6
    const next = resolveRange(manual, applied, { from: 1, to: 5 });
    expect(next.find((m) => m.id === "a")!.startSec).toBe(3.3);
    expect(next.find((m) => m.id === "b")!.measure).toBe(4); // still pending: touches bar 6
    expect(pendingOf(manual, next).map((i) => i.id)).toEqual(["b"]);
  });

  it("a whole-piece recompute applies everything", () => {
    const manual = [mk("c", 5, 9.3)];
    expect(pendingOf(manual, resolveRange(manual, applied, null))).toEqual([]);
  });

  it("never yields two applied markers on one note", () => {
    const appliedA = [mk("a", 3, 5.1)];
    const manual = [mk("a", 8, 15.1), mk("b", 3, 5.3)]; // a moves away (outside the range), b takes its note
    const next = resolveRange(manual, appliedA, { from: 1, to: 5 });
    expect(next.filter((m) => m.measure === 3)).toHaveLength(1);
    expect(next.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("parseSyncState", () => {
  const base = { method: "x", auto: [{ n: 1, startSec: 0, confidence: 50, extra: 1 }], manual: [mk("a", 1, 0.5)], averageConfidence: 50, junk: true };

  it("strict: drops unknown keys and keeps applied and labels", () => {
    const { sync } = parseSyncState({ ...base, applied: [mk("a", 1, 0.5, undefined, { label: "In" })] }, "strict");
    expect(sync).not.toHaveProperty("junk");
    expect(sync.auto[0]).toEqual({ n: 1, startSec: 0, confidence: 50 });
    expect(sync.applied![0].label).toBe("In");
  });

  it("strict: rejects bad types, long labels and duplicate ids within a list", () => {
    expect(() => parseSyncState({ ...base, manual: [mk("a", 1, -1)] }, "strict")).toThrow(SyncShapeError);
    expect(() => parseSyncState({ ...base, manual: [mk("a", 1, 1, undefined, { label: "x".repeat(81) })] }, "strict")).toThrow(SyncShapeError);
    expect(() => parseSyncState({ ...base, manual: [mk("a", 1, 1), mk("a", 1, 2, 0.5)] }, "strict")).toThrow(SyncShapeError);
    expect(() => parseSyncState({ ...base, manual: [mk("x".repeat(101), 1, 1)] }, "strict")).toThrow(SyncShapeError);
  });

  it("lenient: drops bad entries and re-ids a duplicate", () => {
    const { sync, dropped } = parseSyncState({ ...base, manual: [mk("a", 1, 1), mk("a", 1, 2, 0.5), { nope: 1 }] }, "lenient");
    expect(sync.manual.map((m) => m.id)).toEqual(["a", "a-2"]);
    expect(dropped).toBe(2);
  });
});
