-- Append-only profile cache. No room, pick, or dataset changes.
CREATE TABLE IF NOT EXISTS nba_draft.player_photos (
  player_id bigint PRIMARY KEY CHECK (player_id > 0),
  status text NOT NULL CHECK (status IN ('cached', 'missing')),
  image bytea,
  content_type text,
  digest text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'missing' AND image IS NULL AND content_type IS NULL AND digest IS NULL)
    OR (status = 'cached' AND image IS NOT NULL AND content_type IS NOT NULL AND digest IS NOT NULL
        AND octet_length(image) BETWEEN 1 AND 2097152
        AND content_type IN ('image/png', 'image/jpeg') AND digest ~ '^[0-9a-f]{64}$')
  )
);
