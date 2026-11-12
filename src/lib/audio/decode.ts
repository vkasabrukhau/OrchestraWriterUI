import { BRIGHTNESS_LADDER } from "@/shared/dynamics";
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio } from "@/shared/sync";

/**
 * Decoding the uploaded recording, waveform peaks for the transport, and the
 * mono PCM handed to the aligner. Peaks are only drawn in the scrubber; the
 * glow never reads the recording's loudness (design principle 1).
 */

/** The subset of AudioBuffer these helpers read, so they run in tests without Web Audio. */
export type AudioBufferLike = Pick<AudioBuffer, "numberOfChannels" | "length" | "sampleRate" | "getChannelData">;

/** Sample rate used for decoding and for the generated (score) playback. */
export const DECODE_SAMPLE_RATE = 44100;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;
type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
  webkitOfflineAudioContext?: OfflineCtor;
}

let sharedContext: AudioContext | null = null;

/**
 * The one live AudioContext for playback. Create it inside a user gesture
 * (play) so autoplay policies let it start; callers resume() it there too.
 */
export function getAudioContext(): AudioContext {
  if (typeof window === "undefined") throw new Error("Audio playback needs a browser.");
  if (!sharedContext || sharedContext.state === "closed") {
    const Ctor: AudioContextCtor | undefined = window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
    if (!Ctor) throw new Error("This browser does not support Web Audio, so the generated playback cannot play.");
    sharedContext = new Ctor({ latencyHint: "playback" });
  }
  return sharedContext;
}

export function offlineContextCtor(): OfflineCtor {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor } & WebkitWindow;
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("This browser does not support Web Audio (OfflineAudioContext).");
  return Ctor;
}

let decodeContext: OfflineAudioContext | null = null;

/**
 * Decode an MP3 (or anything the browser can decode) into an AudioBuffer at
 * 44.1 kHz. Uses an OfflineAudioContext so no audio device is opened and no
 * user gesture is needed. An ArrayBuffer input is copied first because
 * decodeAudioData detaches its argument.
 */
export async function decodeAudioFile(input: File | Blob | ArrayBuffer): Promise<AudioBuffer> {
  const data = input instanceof ArrayBuffer ? input.slice(0) : await input.arrayBuffer();
  if (data.byteLength === 0) throw new Error("The audio file is empty.");
  if (!decodeContext) {
    const Ctor = offlineContextCtor();
    decodeContext = new Ctor(2, 1, DECODE_SAMPLE_RATE);
  }
  return decodeWith(decodeContext, data);
}

/** Promise or callback form (older Safari returns undefined and only calls back). */
export function decodeWith(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(readableDecodeError(err));
    };
    try {
      const p = ctx.decodeAudioData(data, ok, (e) => fail(e)) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === "function") p.then(ok, fail);
    } catch (err) {
      fail(err);
    }
  });
}

function readableDecodeError(err: unknown): Error {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return new Error(`The recording could not be decoded. Use an MP3 file; other formats may not be supported by this browser${detail}.`);
}

/** Mono downmix of a buffer as a new Float32Array. */
export function downmixToMono(buffer: AudioBufferLike): Float32Array {
  const n = buffer.length;
  const ch = Math.max(1, buffer.numberOfChannels);
  if (ch === 1) return new Float32Array(buffer.getChannelData(0));
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  const k = 1 / ch;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/**
 * Waveform peaks for the transport: max |sample| per bar of the mono
 * downmix, normalized to the 98th percentile so a few loud hits don't
 * flatten the rest. Values 0–1.
 */
export function peaksFromAudioBuffer(buffer: AudioBufferLike, bars = 420): number[] {
  const count = Math.max(1, Math.floor(bars));
  const n = buffer.length;
  if (n === 0) return new Array<number>(count).fill(0);
  const ch = Math.max(1, buffer.numberOfChannels);
  const channels = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  const raw = new Array<number>(count).fill(0);
  const k = 1 / ch;
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let peak = 0;
    for (let i = from; i < to && i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += channels[c][i];
      const a = Math.abs(s * k);
      if (a > peak) peak = a;
    }
    raw[b] = peak;
  }
  return normalizeToPercentile(raw, 0.98);
}

/** Scale so the given percentile maps to 1 (values above are clamped). */
export function normalizeToPercentile(values: number[], percentile: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(percentile * (sorted.length - 1))));
  let ref = sorted[idx];
  if (!(ref > 0)) ref = sorted[sorted.length - 1];
  if (!(ref > 0)) return values.map(() => 0);
  return values.map((v) => Math.max(0, Math.min(1, v / ref)));
}

/**
 * Mono PCM for the aligner (src/shared/sync.ts AlignAudio). With a window,
 * only those seconds are downmixed (a range re-sync never copies the whole
 * recording); `durationSec` is then the window's length.
 */
export function toAlignAudio(buffer: AudioBufferLike, window?: { startSec: number; endSec: number }): AlignAudio {
  const rate = buffer.sampleRate;
  if (!window) {
    return { sampleRate: rate, samples: downmixToMono(buffer), durationSec: rate > 0 ? buffer.length / rate : 0 };
  }
  const a = Math.max(0, Math.min(buffer.length, Math.floor(window.startSec * rate)));
  const b = Math.max(a, Math.min(buffer.length, Math.ceil(window.endSec * rate)));
  const n = b - a;
  const ch = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[a + i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return { sampleRate: rate, samples: out, durationSec: rate > 0 ? n / rate : 0 };
}

/**
 * Score-derived envelope for generated playback: per bar, the sum over parts
 * playing in that bar of BRIGHTNESS_LADDER[loudest dynamic], normalized so
 * the busiest bar is 1. Reads only the info map (written dynamics).
 */
export function peaksFromInfoMap(infoMap: InfoMap, bars = 420): number[] {
  const count = Math.max(1, Math.floor(bars));
  const totals = new Float64Array(count);
  let duration = infoMap.duration;
  if (!(duration > 0)) {
    for (const inst of infoMap.instruments) for (const n of inst.notes) duration = Math.max(duration, n.time + n.duration);
  }
  if (!(duration > 0)) return new Array<number>(count).fill(0);
  const barSec = duration / count;
  const part = new Float64Array(count);
  for (const inst of infoMap.instruments) {
    part.fill(0);
    let any = false;
    for (const note of inst.notes) {
      const level = BRIGHTNESS_LADDER[note.dynamics] ?? 0;
      const end = note.time + Math.max(0, note.duration);
      const b0 = Math.max(0, Math.floor(note.time / barSec));
      // a note ending exactly on a bar edge does not play in the next bar
      const b1 = Math.min(count - 1, Math.ceil(end / barSec) - 1);
      for (let b = b0; b <= Math.max(b0, b1) && b < count; b++) {
        if (level > part[b]) part[b] = level;
        any = true;
      }
    }
    if (any) for (let b = 0; b < count; b++) totals[b] += part[b];
  }
  let max = 0;
  for (let b = 0; b < count; b++) if (totals[b] > max) max = totals[b];
  const out = new Array<number>(count);
  for (let b = 0; b < count; b++) out[b] = max > 0 ? totals[b] / max : 0;
  return out;
}

/** Resample a peaks array (e.g. server-side audio_peaks) to a different bar count, keeping maxima. */
export function resamplePeaks(peaks: number[], bars = 420): number[] {
  const count = Math.max(1, Math.floor(bars));
  if (peaks.length === 0) return new Array<number>(count).fill(0);
  if (peaks.length === count) return peaks.slice();
  const out = new Array<number>(count);
  for (let b = 0; b < count; b++) {
    const from = (b * peaks.length) / count;
    const to = ((b + 1) * peaks.length) / count;
    let v = 0;
    const i0 = Math.floor(from);
    const i1 = Math.max(i0, Math.ceil(to) - 1);
    for (let i = i0; i <= i1 && i < peaks.length; i++) v = Math.max(v, peaks[i]);
    out[b] = v;
  }
  return out;
}
