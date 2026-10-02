-- One shared, immutable player dataset per distinct ESPN pool. Rooms keep only its id.
CREATE TABLE IF NOT EXISTS nba_draft.datasets (
  id bigserial PRIMARY KEY,
  season integer NOT NULL,
  digest text NOT NULL UNIQUE,
  meta jsonb NOT NULL,
  players jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION nba_draft.dataset_digest(season integer, mapping integer, players jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(season || ':' || coalesce(mapping, 0) || ':' || players::text, 'UTF8')), 'hex')
$$;
ALTER TABLE nba_draft.catalogs ADD COLUMN IF NOT EXISTS dataset_id bigint REFERENCES nba_draft.datasets(id);
ALTER TABLE nba_draft.catalogs ADD COLUMN IF NOT EXISTS checked_at timestamptz;

-- Move cached season snapshots into datasets. The snapshot copy is cleared only after its dataset exists.
INSERT INTO nba_draft.datasets(season, digest, meta, players)
SELECT season, nba_draft.dataset_digest(season, (snapshot->>'mapping')::int, snapshot->'players'),
       (snapshot - 'players' - 'warning') || jsonb_build_object('warning', snapshot->'warning'), snapshot->'players'
FROM nba_draft.catalogs WHERE snapshot ? 'players'
ON CONFLICT (digest) DO NOTHING;
UPDATE nba_draft.catalogs c SET dataset_id = d.id, checked_at = (c.snapshot->>'fetchedAt')::timestamptz, snapshot = NULL
FROM nba_draft.datasets d
WHERE c.snapshot ? 'players'
  AND d.digest = nba_draft.dataset_digest(c.season, (c.snapshot->>'mapping')::int, c.snapshot->'players');

-- Move each room's frozen player pool into a shared dataset and pin the room to it.
INSERT INTO nba_draft.datasets(season, digest, meta, players)
SELECT DISTINCT ON (digest) season, digest, meta, players FROM (
  SELECT (data->'catalog'->>'season')::int AS season,
         nba_draft.dataset_digest((data->'catalog'->>'season')::int, (data->'catalog'->>'mapping')::int, data->'catalog'->'players') AS digest,
         (data->'catalog') - 'players' AS meta, data->'catalog'->'players' AS players
  FROM nba_draft.rooms WHERE data->'catalog' ? 'players'
) legacy ORDER BY digest
ON CONFLICT (digest) DO NOTHING;
UPDATE nba_draft.rooms r
SET data = jsonb_set(r.data, '{catalog}', ((r.data->'catalog') - 'players') || jsonb_build_object('dataset', d.id))
FROM nba_draft.datasets d
WHERE r.data->'catalog' ? 'players'
  AND d.digest = nba_draft.dataset_digest((r.data->'catalog'->>'season')::int, (r.data->'catalog'->>'mapping')::int, r.data->'catalog'->'players');

-- Rooms also keep the dataset digest, which the browser's cached player URL includes.
UPDATE nba_draft.rooms r
SET data = jsonb_set(r.data, '{catalog,digest}', to_jsonb(d.digest))
FROM nba_draft.datasets d
WHERE r.data->'catalog' ? 'dataset' AND NOT r.data->'catalog' ? 'digest'
  AND d.id = (r.data->'catalog'->>'dataset')::bigint;
