-- pool_metrics' 24h laterals scan pool_minute_stats per pool per request.
-- With thousands of pools that is per-request work proportional to pool
-- count; a materialized rollup turns it into one indexed join. The worker
-- refreshes it CONCURRENTLY every 30s (24h volume tolerates that lag).
CREATE MATERIALIZED VIEW IF NOT EXISTS backend.pool_metrics_24h AS
SELECT
  m."chain_id",
  m."pool_id",
  COALESCE(sum(m."buy_volume_eth" + m."sell_volume_eth"), 0) AS "vol_24h",
  (
    SELECT m2."close_sqrt_x96"
    FROM backend.pool_minute_stats m2
    WHERE m2."chain_id" = m."chain_id"
      AND m2."pool_id" = m."pool_id"
      AND m2."minute" <= now() - interval '24 hours'
    ORDER BY m2."minute" DESC
    LIMIT 1
  ) AS "price_24h_ago_sqrt_x96"
FROM backend.pool_minute_stats m
WHERE m."minute" >= now() - interval '24 hours'
GROUP BY m."chain_id", m."pool_id";

CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_metrics_24h_key
  ON backend.pool_metrics_24h ("chain_id", "pool_id");
