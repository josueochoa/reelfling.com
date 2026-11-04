-- One claimed part per sequence. continueSequence inserts the next number in a
-- single statement so two continues cannot take the same (sequence, part).
--
-- The number already lives in generations.data (sequenceId, part) and in
-- fal_jobs.data (sequence.sequenceId, sequence.part). A race before this
-- index could have stored the same pair twice. Those JSON documents are not
-- rewritten — renumbering would change the feed. This backfill keeps the
-- earliest row for each pair (a generation wins a timestamp tie) so the
-- unique index can be created.

CREATE TABLE sequence_parts (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL,
  part        INTEGER NOT NULL,
  source_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX sequence_parts_by_sequence_part ON sequence_parts (sequence_id, part);

INSERT INTO sequence_parts (user_id, sequence_id, part, source_id, created_at)
SELECT user_id, sequence_id, part, source_id, created_at
FROM (
  SELECT
    user_id,
    sequence_id,
    part,
    source_id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY sequence_id, part
      ORDER BY created_at, kind, source_id
    ) AS n
  FROM (
    SELECT
      user_id,
      json_extract(data, '$.sequenceId') AS sequence_id,
      json_extract(data, '$.part') AS part,
      id AS source_id,
      created_at,
      0 AS kind
    FROM generations
    WHERE json_extract(data, '$.sequenceId') IS NOT NULL
      AND typeof(json_extract(data, '$.part')) = 'integer'
      AND json_extract(data, '$.part') >= 1
    UNION ALL
    SELECT
      user_id,
      json_extract(data, '$.sequence.sequenceId') AS sequence_id,
      json_extract(data, '$.sequence.part') AS part,
      COALESCE(json_extract(data, '$.sequence.sourceGenerationId'), id) AS source_id,
      created_at,
      1 AS kind
    FROM fal_jobs
    WHERE json_extract(data, '$.sequence.sequenceId') IS NOT NULL
      AND typeof(json_extract(data, '$.sequence.part')) = 'integer'
      AND json_extract(data, '$.sequence.part') >= 1
  ) AS claimed
) AS ranked
WHERE n = 1;
