/** Queued or running videos older than this are failed by the cron sweep. Any provider. */
export const STALE_VIDEO_MS = 2 * 60 * 60 * 1000;

export const STALE_VIDEO_ERROR = "Timed out after 2 hours. The provider never finished this job.";

/** The sweep's update. `created_at <= now - 2h` so a job is failed once it has been open for 2 hours. */
export function staleVideoFailure(now = Date.now()) {
  return {
    sql: `UPDATE generations
       SET data = json_set(data, '$.status', 'failed', '$.error', ?,
                           '$.completedAt', ?, '$.updatedAt', ?)
       WHERE json_extract(data, '$.status') IN ('queued', 'running')
         AND created_at <= ?`,
    params: [STALE_VIDEO_ERROR, now, now, now - STALE_VIDEO_MS],
  };
}
