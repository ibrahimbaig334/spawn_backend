-- backend.swaps mirror-view: expose the sink's trader column (tx signer) and
-- log_index (PnL ordering). Recreated wholesale: view column types are fixed
-- at creation, so a trader column cannot be added in place.

DROP VIEW IF EXISTS backend.swaps;
CREATE VIEW backend.swaps AS
SELECT
  1337 AS chain_id,
  (block_number || ':'::text) || log_index AS ordinal_key,
  pool_id,
  token,
  sender,
  trader,
  is_buy,
  amount0_eth,
  amount1_tokens,
  sqrt_price_x96,
  liquidity,
  tick,
  fee,
  fee_eth,
  fee_tokens,
  tx_hash,
  log_index,
  block_number,
  to_timestamp("timestamp") AS "timestamp"
FROM public.swaps;
