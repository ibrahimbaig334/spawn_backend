-- ATH axis fix: ath_sqrt_x96 was accumulated with MAX(sqrt) by the sink, but
-- the price axis is inverted (ETH-per-token = 2^192/sqrt^2), so MAX(sqrt) is
-- the all-time-LOW price. Rebuild it from minute stats: a minute's low_sqrt
-- is its minimum sqrt (= its highest ETH price); the global minimum across
-- minutes is the true all-time-high price sqrt.
-- Safe to re-run. Requires the sink's .min() fix for new swaps.

UPDATE public.pool_stats s
SET ath_sqrt_x96 = agg.min_low_sqrt
FROM (
  SELECT pool_id, MIN(low_sqrt_x96) AS min_low_sqrt
  FROM public.pool_minute_stats
  WHERE low_sqrt_x96 IS NOT NULL AND low_sqrt_x96 > 0
  GROUP BY pool_id
) agg
WHERE s.pool_id = agg.pool_id
  AND (s.ath_sqrt_x96 IS NULL OR s.ath_sqrt_x96 <= 0 OR s.ath_sqrt_x96 > agg.min_low_sqrt);
