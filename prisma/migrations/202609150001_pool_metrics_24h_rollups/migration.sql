-- 24h rollups on pool_metrics: rolling volume and the price 24h ago, so the
-- markets list can show Δ24h without per-pool candle fetches.
-- Replaces the backend.pool_metrics mirror-view; fully qualified to the
-- backend mirror layer (which adds the constant chain_id over sink tables).

DROP VIEW IF EXISTS backend.pool_metrics;
CREATE VIEW backend.pool_metrics AS
SELECT
  p."chain_id",
  p."pool_id",
  p.status,
  p.token,
  p.creator,
  p."total_supply",
  (p."total_supply" - COALESCE(s.burned_total, 0)) AS "circulating_supply",
  p."opening_level",
  p."far_level",
  p."graduation_level",
  p."payout_plan",
  p."dev_buy_share_wad",
  p."config_hash",
  p."wall_liquidity",
  p."revenue_nft_owner",
  p."launch_block",
  p."launch_time",
  p."graduation_block",
  p."graduation_time",
  t.name,
  t.symbol,
  t.uri,
  s."buy_volume_eth",
  s."sell_volume_eth",
  s."swap_count",
  s."last_price_sqrt_x96",
  s."ath_sqrt_x96",
  s."creator_revenue_total",
  s."protocol_revenue_total",
  COALESCE(v24."vol_24h", 0) AS "vol_24h_wei",
  v24."price_24h_ago_sqrt_x96" AS "price_24h_ago_sqrt_x96",
  CASE WHEN s."last_price_sqrt_x96" > 0
    THEN (p."total_supply" * (2::numeric ^ 192)) / (s."last_price_sqrt_x96" * s."last_price_sqrt_x96")
  END AS "fdv_wei",
  CASE WHEN s."last_price_sqrt_x96" > 0
    THEN ((p."total_supply" - COALESCE(s.burned_total, 0)) * (2::numeric ^ 192)) / (s."last_price_sqrt_x96" * s."last_price_sqrt_x96")
  END AS "mcap_wei",
  CASE WHEN s."ath_sqrt_x96" > 0
    THEN ((p."total_supply" - COALESCE(s.burned_total, 0)) * (2::numeric ^ 192)) / (s."ath_sqrt_x96" * s."ath_sqrt_x96")
  END AS "ath_mcap_wei"
FROM backend.pools p
JOIN backend.tokens t ON t."chain_id" = p."chain_id" AND t.token = p.token
LEFT JOIN backend.pool_stats s ON s."chain_id" = p."chain_id" AND s."pool_id" = p."pool_id"
LEFT JOIN backend.pool_metrics_24h v24
  ON v24."chain_id" = p."chain_id" AND v24."pool_id" = p."pool_id";
