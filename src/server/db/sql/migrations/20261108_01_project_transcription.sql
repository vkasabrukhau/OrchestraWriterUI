-- Experimental: a score transcribed from the
-- recording by the local MuScriptor service (ml/server.py).
--
-- {key, model, detected, bars, bpm, beatsPerBar, warnings, title}: `key` is the
-- S3 object holding the transcription itself (the model's notes and the beat
-- grid), so the bars can be rewritten without running the model again. NULL
-- for an uploaded score; cleared when a score is uploaded or the recording changes.
ALTER TABLE app.projects ADD COLUMN transcription JSONB;
