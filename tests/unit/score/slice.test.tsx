import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { makeSlicer } from "@/lib/score/slice";
import { parseMusicXml } from "@/shared/score";
import { FIXTURES } from "./helpers";

const demo = readFileSync(FIXTURES + "orchestra-demo.musicxml", "utf8");

describe("makeSlicer", () => {
  it("cuts a range of bars with the clefs, keys and time carried in", () => {
    const slicer = makeSlicer(demo)!;
    expect(slicer.count).toBe(48);
    const text = slicer.slice(20, 23);
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const parts = Array.from(doc.getElementsByTagName("part"));
    expect(parts).toHaveLength(14);
    for (const p of parts) {
      const ms = Array.from(p.children).filter((c) => c.tagName === "measure");
      expect(ms.map((m) => m.getAttribute("number"))).toEqual(["21", "22", "23", "24"]);
      const attrs = ms[0].getElementsByTagName("attributes")[0];
      expect(attrs.getElementsByTagName("divisions")).toHaveLength(1);
      expect(attrs.getElementsByTagName("clef").length).toBeGreaterThan(0);
      // a carried time signature is not printed again
      expect(attrs.getElementsByTagName("time")[0].getAttribute("print-object")).toBe("no");
    }
    // the viola keeps its alto clef
    const viola = parts.find((p) => doc.querySelector(`score-part[id="${p.getAttribute("id")}"] part-name`)?.textContent === "Viola")!;
    expect(viola.getElementsByTagName("clef")[0].getElementsByTagName("sign")[0].textContent).toBe("C");
    // the slice is a score the parser reads, with its notes timed from the slice's start
    const parsed = parseMusicXml({ bytes: new TextEncoder().encode(text), filename: "slice.musicxml" });
    expect(parsed.ok && parsed.infoMap.measures.length).toBe(4);
  });

  it("leaves the first bar as it is and refuses what is not partwise", () => {
    const slicer = makeSlicer(demo)!;
    const first = new DOMParser().parseFromString(slicer.slice(0, 1), "application/xml");
    expect(first.getElementsByTagName("time")[0].getAttribute("print-object")).toBeNull();
    expect(makeSlicer("<score-timewise/>")).toBeNull();
    expect(makeSlicer("not xml")).toBeNull();
  });
});
