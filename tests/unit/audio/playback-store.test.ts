import { beforeEach, describe, expect, it } from "vitest";
import { usePlayback } from "@/lib/store/playback";
import type { AudioEngine } from "@/lib/audio/engine";

class FakeEngine implements AudioEngine {
  readonly kind = "recording" as const;
  duration = 120;
  t = 0;
  isPlaying = false;
  isEnded = false;
  rate = 1;
  volume = 1;
  muted = false;
  calls: string[] = [];
  loadResult: Promise<void> = Promise.resolve();
  playResult: () => Promise<void> = () => Promise.resolve();
  destroyed = false;

  load() {
    this.calls.push("load");
    return this.loadResult;
  }
  play() {
    this.calls.push("play");
    this.isPlaying = true;
    return this.playResult();
  }
  pause() {
    this.calls.push("pause");
    this.isPlaying = false;
  }
  seek(t: number) {
    this.calls.push(`seek:${t}`);
    this.t = t;
    this.isEnded = false;
  }
  setRate(r: number) {
    this.rate = r;
  }
  setVolume(v: number) {
    this.volume = v;
  }
  setMuted(m: boolean) {
    this.muted = m;
  }
  currentTime() {
    return this.t;
  }
  ended() {
    return this.isEnded;
  }
  paused() {
    return !this.isPlaying;
  }
  destroy() {
    this.destroyed = true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function resetStore() {
  usePlayback.getState().attach(null);
  usePlayback.setState({ playing: false, time: 0, duration: 438, rate: 1, volume: 0.8, muted: false, loop: false, range: null, cue: null });
}

describe("playback store without an engine (silent clock)", () => {
  beforeEach(resetStore);

  it("integrates dt while playing and stops at the end", () => {
    const s = usePlayback.getState();
    s.reset(10, 0);
    s.play();
    usePlayback.getState().tick(0.5);
    expect(usePlayback.getState().time).toBeCloseTo(0.5);
    usePlayback.getState().setRate(2);
    usePlayback.getState().tick(0.5);
    expect(usePlayback.getState().time).toBeCloseTo(1.5);
    usePlayback.getState().tick(100);
    expect(usePlayback.getState()).toMatchObject({ time: 10, playing: false });
    expect(usePlayback.getState().ready).toBe(true);
  });
});

describe("playback store with an engine", () => {
  beforeEach(resetStore);

  it("attaches, loads, adopts the engine duration and seeks it to the playhead", async () => {
    usePlayback.setState({ time: 30, volume: 0.5, muted: true, rate: 0.75 });
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    expect(usePlayback.getState()).toMatchObject({ engine: e, ready: false, error: null });
    expect(e).toMatchObject({ volume: 0.5, muted: true, rate: 0.75 });
    await flush();
    expect(usePlayback.getState()).toMatchObject({ ready: true, duration: 120, time: 30 });
    expect(e.calls).toContain("seek:30");
  });

  it("forwards play, pause, seek, skip, rate, volume and mute", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    const s = usePlayback.getState();
    s.play();
    expect(e.isPlaying).toBe(true);
    expect(usePlayback.getState().playing).toBe(true);
    s.seek(50);
    expect(e.t).toBe(50);
    s.skip(-5);
    expect(e.t).toBe(45);
    s.seek(999);
    expect(e.t).toBe(120);
    s.setRate(0.5);
    expect(e.rate).toBe(0.5);
    s.setVolume(0.3);
    expect(e.volume).toBe(0.3);
    s.toggleMute();
    expect(e.muted).toBe(true);
    e.t = 61.25;
    s.pause();
    expect(e.isPlaying).toBe(false);
    expect(usePlayback.getState()).toMatchObject({ playing: false, time: 61.25 });
    s.toggle();
    expect(e.isPlaying).toBe(true);
  });

  it("tick reads the engine's time instead of integrating dt", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().play();
    e.t = 12.5;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState().time).toBe(12.5);
    e.t = 12.6;
    usePlayback.getState().tick(5);
    expect(usePlayback.getState().time).toBeCloseTo(12.6);
  });

  it("extrapolates a coarse media clock between updates, at most 0.25 s ahead", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().play();
    e.t = 10;
    usePlayback.getState().tick(0.016);
    e.t = 10.2; // clock is moving
    usePlayback.getState().tick(0.016);
    usePlayback.getState().tick(0.1); // no update from the engine
    expect(usePlayback.getState().time).toBeCloseTo(10.3);
    usePlayback.getState().tick(1);
    expect(usePlayback.getState().time).toBeCloseTo(10.45);
  });

  it("pauses at the end, or loops", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().play();
    e.t = 120;
    e.isEnded = true;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState()).toMatchObject({ playing: false, time: 120 });
    expect(e.isPlaying).toBe(false);

    // play at the end restarts from 0
    usePlayback.getState().play();
    expect(e.t).toBe(0);
    usePlayback.getState().toggleLoop();
    e.t = 120;
    e.isEnded = true;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState()).toMatchObject({ playing: true, time: 0 });
    expect(e.calls.filter((c) => c === "play").length).toBe(3);
  });

  it("repeats a passage: starts inside it and jumps back at its end", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().seek(5);
    usePlayback.getState().setRange({ start: 30, end: 20 }); // either order
    expect(usePlayback.getState().range).toEqual({ start: 20, end: 30 });
    usePlayback.getState().play();
    expect(e.t).toBe(20);
    e.t = 25;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState().time).toBe(25);
    e.t = 30.01;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState()).toMatchObject({ playing: true, time: 20 });
    expect(e.t).toBe(20);
    usePlayback.getState().setRange(null);
    expect(usePlayback.getState().range).toBeNull();
  });

  it("plays from the start point or resumes from the playhead", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().seek(40);
    usePlayback.getState().setCue({ at: 12, measure: 5, position: 0.5, label: "bar 5, beat 3" });
    expect(usePlayback.getState().time).toBe(40); // setting a start point does not move the playhead
    usePlayback.getState().play();
    expect(e.t).toBe(40);
    usePlayback.getState().pause();
    usePlayback.getState().playFromCue();
    expect(usePlayback.getState()).toMatchObject({ playing: true, time: 12 });
    expect(e.t).toBe(12);
    usePlayback.getState().reset(120);
    expect(usePlayback.getState().cue).toBeNull();
  });

  it("notices a pause from outside the app (OS media keys)", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().play();
    e.t = 33;
    e.isPlaying = false;
    usePlayback.getState().tick(0.016);
    expect(usePlayback.getState()).toMatchObject({ playing: false, time: 33 });
  });

  it("reports a load error and refuses to play", async () => {
    const e = new FakeEngine();
    e.loadResult = Promise.reject(new Error("The recording could not be opened. Its link may have expired"));
    usePlayback.getState().attach(e);
    await flush();
    expect(usePlayback.getState()).toMatchObject({ ready: false, error: expect.stringContaining("expired") });
    usePlayback.getState().play();
    expect(e.isPlaying).toBe(false);
    expect(usePlayback.getState().playing).toBe(false);
  });

  it("reports a blocked play and recovers on the next play", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    e.playResult = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    usePlayback.getState().play();
    await flush();
    expect(usePlayback.getState()).toMatchObject({ playing: false, error: expect.stringContaining("blocked playback") });
    e.playResult = () => Promise.resolve();
    usePlayback.getState().play();
    expect(usePlayback.getState()).toMatchObject({ playing: true, error: null });
  });

  it("ignores the AbortError from pausing before playback started", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    e.playResult = () => Promise.reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
    usePlayback.getState().play();
    usePlayback.getState().pause();
    await flush();
    expect(usePlayback.getState().error).toBeNull();
  });

  it("reset pauses and seeks the engine", async () => {
    const e = new FakeEngine();
    usePlayback.getState().attach(e);
    await flush();
    usePlayback.getState().play();
    usePlayback.getState().reset(100, 42);
    expect(e.isPlaying).toBe(false);
    expect(e.t).toBe(42);
    expect(usePlayback.getState()).toMatchObject({ duration: 100, time: 42, playing: false });
  });

  it("ignores a late load from an engine that was replaced, and detaching restores the silent clock", async () => {
    const slow = new FakeEngine();
    let resolveSlow!: () => void;
    slow.loadResult = new Promise((r) => (resolveSlow = r));
    usePlayback.getState().attach(slow);
    const fast = new FakeEngine();
    fast.duration = 60;
    usePlayback.getState().attach(fast);
    await flush();
    resolveSlow();
    await flush();
    expect(usePlayback.getState()).toMatchObject({ engine: fast, duration: 60 });
    expect(slow.calls).toContain("pause");

    usePlayback.getState().attach(null);
    expect(usePlayback.getState()).toMatchObject({ engine: null, ready: true, error: null });
    usePlayback.getState().play();
    usePlayback.getState().tick(1);
    expect(usePlayback.getState().time).toBeGreaterThan(0);
  });
});
