// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PANEL_SIZES, PANEL_LIMITS, STAGE_MIN_HEIGHT, STAGE_MIN_WIDTH, fitPanels, readPanelSizes, useEditorLayout } from "@/lib/store/editor-layout";

const ALL = { instruments: true, properties: true, lanes: true };

describe("fitPanels", () => {
  it("draws the stored sizes when they fit", () => {
    const { size } = fitPanels({ instruments: 300, properties: 340, lanes: 280 }, { width: 1400, height: 800 }, ALL);
    expect(size).toEqual({ instruments: 300, properties: 340, lanes: 280 });
  });

  it("keeps the stage its minimum width: properties give way first, then instruments, never below their minimums", () => {
    const stored = { instruments: 400, properties: 460, lanes: 260 };
    const roomy = fitPanels(stored, { width: STAGE_MIN_WIDTH + 400 + 300, height: 800 }, ALL);
    expect(roomy.size.instruments).toBe(400);
    expect(roomy.size.properties).toBe(300);

    // 900 px: properties drop to their minimum (−200), instruments take the rest (−180)
    const partial = fitPanels(stored, { width: 900, height: 800 }, ALL);
    expect(partial.size.properties).toBe(PANEL_LIMITS.properties[0]);
    expect(partial.size.instruments).toBe(900 - STAGE_MIN_WIDTH - PANEL_LIMITS.properties[0]);

    const tight = fitPanels(stored, { width: 800, height: 800 }, ALL);
    expect(tight.size.properties).toBe(PANEL_LIMITS.properties[0]);
    expect(tight.size.instruments).toBe(PANEL_LIMITS.instruments[0]);
  });

  it("a hidden side panel leaves its room to the other one", () => {
    const { size, max } = fitPanels({ instruments: 440, properties: 300, lanes: 260 }, { width: 900, height: 800 }, { ...ALL, properties: false });
    expect(size.instruments).toBe(440);
    expect(max.instruments).toBe(PANEL_LIMITS.instruments[1]);
  });

  it("drag limits leave the stage its minimum width and height", () => {
    const { max } = fitPanels(DEFAULT_PANEL_SIZES, { width: 1000, height: 700 }, ALL);
    expect(max.instruments).toBe(1000 - STAGE_MIN_WIDTH - DEFAULT_PANEL_SIZES.properties);
    expect(max.properties).toBe(1000 - STAGE_MIN_WIDTH - DEFAULT_PANEL_SIZES.instruments);
    expect(max.lanes).toBe(700 - STAGE_MIN_HEIGHT);
  });

  it("the lanes shrink to keep the stage area tall enough", () => {
    const { size } = fitPanels({ ...DEFAULT_PANEL_SIZES, lanes: 600 }, { width: 1400, height: 600 }, ALL);
    expect(size.lanes).toBe(600 - STAGE_MIN_HEIGHT);
  });

  it("uses the full limits before the grid is measured", () => {
    const { size, max } = fitPanels(DEFAULT_PANEL_SIZES, { width: 0, height: 0 }, ALL);
    expect(size).toEqual(DEFAULT_PANEL_SIZES);
    expect(max.lanes).toBe(PANEL_LIMITS.lanes[1]);
  });
});

describe("panel sizes in storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEditorLayout.setState({ sizes: DEFAULT_PANEL_SIZES, loaded: false });
  });

  it("falls back to the defaults for missing or unreadable values and clamps the rest", () => {
    expect(readPanelSizes()).toEqual(DEFAULT_PANEL_SIZES);
    window.localStorage.setItem("ov:editor-layout:v1", "{not json");
    expect(readPanelSizes()).toEqual(DEFAULT_PANEL_SIZES);
    window.localStorage.setItem("ov:editor-layout:v1", JSON.stringify({ instruments: 9999, properties: "wide", lanes: 50 }));
    expect(readPanelSizes()).toEqual({ instruments: PANEL_LIMITS.instruments[1], properties: DEFAULT_PANEL_SIZES.properties, lanes: PANEL_LIMITS.lanes[0] });
  });

  it("remembers a resize and a reset", () => {
    useEditorLayout.getState().resize("instruments", 320);
    expect(readPanelSizes().instruments).toBe(320);
    useEditorLayout.getState().reset("instruments");
    expect(useEditorLayout.getState().sizes.instruments).toBe(DEFAULT_PANEL_SIZES.instruments);
    expect(readPanelSizes().instruments).toBe(DEFAULT_PANEL_SIZES.instruments);
  });
});
