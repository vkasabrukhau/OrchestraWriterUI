import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The recording engine that plays the decoded audio (createBufferedRecordingEngine):
 * its playhead comes from the AudioContext clock, so it is exact after any
 * jump. A variable-bitrate MP3 in <audio> reported the requested time while
 * the music was up to 2.3 s elsewhere.
 */

interface FakeSource {
  buffer: unknown;
  playbackRate: { value: number };
  onended: (() => void) | null;
  started: { when: number; offset: number } | null;
  stopped: boolean;
  connect(): void;
  disconnect(): void;
  start(when: number, offset: number): void;
  stop(): void;
}

class FakeContext {
  static instance: FakeContext;
  currentTime = 100; // arbitrary non-zero clock
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  constructor() {
    FakeContext.instance = this;
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} };
  }
  createBufferSource(): FakeSource {
    const s: FakeSource = {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      started: null,
      stopped: false,
      connect() {},
      disconnect() {},
      start(when, offset) {
        s.started = { when, offset };
      },
      stop() {
        s.stopped = true;
      },
    };
    this.sources.push(s);
    return s;
  }
}

let createBufferedRecordingEngine: typeof import("@/lib/audio/engine").createBufferedRecordingEngine;

beforeAll(async () => {
  vi.stubGlobal("window", { AudioContext: FakeContext });
  ({ createBufferedRecordingEngine } = await import("@/lib/audio/engine"));
});

const buffer = { duration: 600 } as AudioBuffer;
const ctx = () => FakeContext.instance;
const last = () => ctx().sources[ctx().sources.length - 1];

describe("buffered recording engine", () => {
  it("starts the decoded audio exactly where it was asked to and reports that position", async () => {
    const engine = createBufferedRecordingEngine("blob:x", () => Promise.resolve(buffer));
    await engine.load();
    expect(engine.duration).toBe(600);
    engine.seek(108.07); // bar 19
    expect(engine.currentTime()).toBe(108.07);
    await engine.play();
    expect(last().started?.offset).toBe(108.07);
    // 2.5 s of audio clock after the source starts
    ctx().currentTime = last().started!.when + 2.5;
    expect(engine.currentTime()).toBeCloseTo(110.57, 9);
    engine.destroy();
  });

  it("a jump while playing starts a new source at the exact sample and stops the old one", async () => {
    const engine = createBufferedRecordingEngine("blob:x", () => Promise.resolve(buffer));
    await engine.load();
    await engine.play();
    const first = last();
    ctx().currentTime = first.started!.when + 10;
    engine.seek(269.97); // bar 89
    expect(first.stopped).toBe(true);
    expect(last()).not.toBe(first);
    expect(last().started?.offset).toBe(269.97);
    ctx().currentTime = last().started!.when + 1;
    expect(engine.currentTime()).toBeCloseTo(270.97, 9);
    engine.destroy();
  });

  it("keeps the position across pause, rate changes and resume", async () => {
    const engine = createBufferedRecordingEngine("blob:x", () => Promise.resolve(buffer));
    await engine.load();
    engine.seek(50);
    await engine.play();
    ctx().currentTime = last().started!.when + 4;
    engine.setRate(0.5);
    expect(last().playbackRate.value).toBe(0.5);
    expect(last().started?.offset).toBeCloseTo(54, 9);
    ctx().currentTime = last().started!.when + 4; // 4 s of clock at half speed = 2 s of audio
    expect(engine.currentTime()).toBeCloseTo(56, 9);
    engine.pause();
    expect(engine.paused?.()).toBe(true);
    ctx().currentTime += 30;
    expect(engine.currentTime()).toBeCloseTo(56, 9);
    await engine.play();
    expect(last().started?.offset).toBeCloseTo(56, 9);
    engine.destroy();
  });

  it("reports the end of the recording and restarts from the beginning", async () => {
    const engine = createBufferedRecordingEngine("blob:x", () => Promise.resolve(buffer));
    await engine.load();
    engine.seek(599);
    await engine.play();
    last().onended?.();
    expect(engine.ended()).toBe(true);
    expect(engine.paused?.()).toBe(true);
    await engine.play();
    expect(last().started?.offset).toBe(0);
    engine.destroy();
  });
});
