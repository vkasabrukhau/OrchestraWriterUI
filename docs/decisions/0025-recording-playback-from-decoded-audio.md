# 0025. Recording playback from the decoded audio

Date: 2026-11-15
Status: proposed

## Context
The recording was played with an `<audio>` element, and the transport,
cursor and glow read its `currentTime`. The Tchaikovsky 6 upload (Hallé) is
a variable-bitrate MP3 (frames from 32 to 256 kbps) whose only seek aid is a
100-entry Xing table quantized to 1/256 of the file. Chrome seeks such a
file by estimating the byte offset from that table and then reports the
*requested* time.

The music actually heard was:
- 2.33 s ahead after a jump to bar 19 (the table predicts +2.32 s);
- 1.95 s ahead at bar 89 (predicted +1.91 s);
- between −3.5 and +2.3 s elsewhere along the file.

It was correct when playing continuously from the start, and again once
playback had passed through a stretch. The sync looked wrong after any jump,
reload or player recreation, even though the computed timing had not changed.
Re-runs with the same code gave identical bar times. They match the
score-sync-lab result at bars 17–26 (within 0.02 s) and 85–93 (within 0.07 s).
Markers placed by ear after such a jump inherit the error.

## Decision
Play the recording from its decoded PCM with Web Audio
(`createBufferedRecordingEngine`, `src/lib/audio/engine.ts`).

- **Position**: comes from the AudioContext clock, `anchor + (now − start) × rate`.
- **Jumps**: a jump starts a new `AudioBufferSourceNode` at that exact sample.
- **Decoded audio**: the copy alignment and the waveform already use (`api.loadRecordingBuffer`, the per-project LRU), so nothing is decoded twice.
- **Fallback**: if it cannot be loaded, the engine falls back to streaming the file with `<audio>` (`createRecordingEngine`, unchanged). The mock API has no decoded audio and always streams.

## Consequences
- **Exact playhead**: the playhead and the sound agree after every jump, reload and re-attach, in every browser, whatever the MP3 encoding.
- **Slower start**: playback can start only once the file is downloaded and decoded (about 2–3 s for 18 minutes after download). The Sync page already decoded it for the waveform.
- **Pitch at other speeds**: Web Audio changes pitch with the playback rate, so at speeds other than 1× the recording sounds lower or higher (`<audio>` kept the pitch). Revisit with a time-stretching node if slowed-down listening matters.
- **Memory**: the decoded buffer (about 10 MB per minute of stereo) is held while the project is open. It was already held for the waveform and sync.
