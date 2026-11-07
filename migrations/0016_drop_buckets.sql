-- Per-workspace R2 buckets are gone. Every file is in reelfling-media at
-- <user id>/<key>, and the assets table records the bucket for each file.
-- Nothing reads this table any more.
DROP TABLE IF EXISTS buckets;
