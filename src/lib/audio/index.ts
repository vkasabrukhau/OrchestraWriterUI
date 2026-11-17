/** Decoding, peaks, the playback engines (recording / generated) and the hook that attaches them. */
export {
  DECODE_SAMPLE_RATE,
  decodeAudioFile,
  decodeWith,
  downmixToMono,
  getAudioContext,
  normalizeToPercentile,
  peaksFromAudioBuffer,
  peaksFromInfoMap,
  resamplePeaks,
  toAlignAudio,
  type AudioBufferLike,
} from "./decode";
export {
  createBufferedRecordingEngine,
  createRecordingEngine,
  createScoreSynthEngine,
  mediaErrorMessage,
  renderScoreToAudioBuffer,
  type AudioEngine,
  type RenderScoreOptions,
} from "./engine";
export {
  VOICE_ADSR,
  VOICE_GAIN,
  collectSynthNotes,
  envelopePoints,
  midiToHz,
  scheduleWindow,
  velocityFor,
  voiceForInstrument,
  type Adsr,
  type SynthNote,
  type SynthVoice,
} from "./synth";
export { attachPlaybackSource, createEngineFor, useAudioEngine, usePlaybackEngine, type PlaybackSource } from "./usePlaybackEngine";
