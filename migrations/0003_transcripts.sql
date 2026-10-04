-- Milestone 4: AI transcripts and episode enrichment.
-- transcript_status: none | pending | processing | completed | failed
ALTER TABLE episodes ADD COLUMN summary TEXT;
ALTER TABLE episodes ADD COLUMN ai_tags TEXT;            -- JSON array; creator-written tags stay in metadata_tags
ALTER TABLE episodes ADD COLUMN key_quotes TEXT;         -- JSON array of {text, timestamp}
ALTER TABLE episodes ADD COLUMN transcript_error TEXT;   -- short, creator-safe message
ALTER TABLE episodes ADD COLUMN transcript_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN transcript_started_at TEXT;
ALTER TABLE episodes ADD COLUMN transcript_finished_at TEXT;

-- 0001 defaulted transcript_status to 'pending'; 'none' now means "nothing to transcribe".
UPDATE episodes SET transcript_status = 'none' WHERE audio_key IS NULL AND transcript_text IS NULL;

CREATE INDEX idx_episodes_transcript_queue ON episodes(transcript_status, updated_at);
