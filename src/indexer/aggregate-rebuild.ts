import { Prisma } from '../infrastructure/database/prisma.service';

/**
 * Rebuilds every aggregate table from the (canonical, insert-only) fact tables.
 *
 * Facts are the source of truth for aggregates (backend guide §1: facts never
 * updated, aggregates via delta-ops). On a reorg we delete facts from the fork
 * block forward, re-ingest the new blocks, and — because replayed inline delta-ops
 * would double-count against aggregates that were already updated pre-fork — the
 * rollback path rebuilds all aggregates in one pass from surviving facts instead.
 */

export async function rebuildAggregates(
  tx: Prisma.TransactionClient,
  chainId: number,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `DELETE FROM pool_stats WHERE "chain_id" = ${chainId};
     DELETE FROM pool_minute_stats WHERE "chain_id" = ${chainId};
     DELETE FROM pool_hour_stats WHERE "chain_id" = ${chainId};
     DELETE FROM pool_day_stats WHERE "chain_id" = ${chainId};
     DELETE FROM pots WHERE "chain_id" = ${chainId};
     DELETE FROM protocol_day_stats WHERE "chain_id" = ${chainId};
     DELETE FROM protocol_stats WHERE "chain_id" = ${chainId};`,
  );

  // --- pool_stats -----------------------------------------------------------
  await tx.$executeRawUnsafe(`
    INSERT INTO pool_stats (
      "chain_id","pool_id",
      "buy_volume_eth","sell_volume_eth","buy_volume_tokens","sell_volume_tokens","swap_count",
      "last_price_sqrt_x96","ath_sqrt_x96",
      "creator_revenue_total","creator_revenue_curve","creator_revenue_swap_fees",
      "protocol_revenue_total","protocol_revenue_curve","protocol_revenue_swap_fees","protocol_revenue_harvest_fees",
      "creator_path_revenue_total","plugin_revenue_total",
      "pot_funded_total","tips_total","bands_deployed","harvest_count","harvest_quote_total",
      "swap_fee_burned_tokens","burned_total","last_swap_block","updated_at")
    SELECT p."chain_id", p."pool_id",
      COALESCE(sw.bve,0), COALESCE(sw.sve,0), COALESCE(sw.bvt,0), COALESCE(sw.svt,0), COALESCE(sw.cnt,0),
      COALESCE(sw.last_sqrt,0), COALESCE(sw.ath,0),
      COALESCE(ca.total,0), COALESCE(ca.curve,0), COALESCE(ca.fees,0),
      COALESCE(pa.total,0), COALESCE(pa.curve,0), COALESCE(pa.fees,0), COALESCE(pa.harvest,0),
      COALESCE(cpa.total,0), COALESCE(pp.total,0),
      COALESCE(pcf.total,0), COALESCE(tip.total,0),
      COALESCE(bnd.cnt,0), COALESCE(hv.cnt,0), COALESCE(hv.quote,0),
      COALESCE(frb.total,0), COALESCE(burn.total,0),
      COALESCE(sw.last_block,0), now()
    FROM pools p
    LEFT JOIN (
      SELECT "chain_id","pool_id",
        sum(CASE WHEN is_buy THEN "amount0_eth" ELSE 0 END) bve,
        sum(CASE WHEN is_buy THEN 0 ELSE "amount0_eth" END) sve,
        sum(CASE WHEN is_buy THEN "amount1_tokens" ELSE 0 END) bvt,
        sum(CASE WHEN is_buy THEN 0 ELSE "amount1_tokens" END) svt,
        count(*) cnt,
        min("sqrt_price_x96") ath,
        (array_agg("sqrt_price_x96" ORDER BY "block_number" DESC, "log_index" DESC))[1] last_sqrt,
        max("block_number") last_block
      FROM swaps GROUP BY "chain_id","pool_id") sw ON sw."chain_id"=p."chain_id" AND sw."pool_id"=p."pool_id"
    LEFT JOIN (
      SELECT "chain_id","pool_id", sum(amount) total,
        sum(CASE WHEN source='CURVE_PROCEEDS' THEN amount ELSE 0 END) curve,
        sum(CASE WHEN source='SWAP_FEES' THEN amount ELSE 0 END) fees
      FROM creator_accruals GROUP BY "chain_id","pool_id") ca ON ca."chain_id"=p."chain_id" AND ca."pool_id"=p."pool_id"
    LEFT JOIN (
      SELECT "chain_id","pool_id", sum(amount) total,
        sum(CASE WHEN source='CURVE_PROCEEDS' THEN amount ELSE 0 END) curve,
        sum(CASE WHEN source='SWAP_FEES' THEN amount ELSE 0 END) fees,
        sum(CASE WHEN source='MILESTONE_HARVEST' THEN amount ELSE 0 END) harvest
      FROM protocol_accruals GROUP BY "chain_id","pool_id") pa ON pa."chain_id"=p."chain_id" AND pa."pool_id"=p."pool_id"
    LEFT JOIN (SELECT "chain_id","pool_id", sum(amount) total FROM creator_path_accruals GROUP BY "chain_id","pool_id") cpa
      ON cpa."chain_id"=p."chain_id" AND cpa."pool_id"=p."pool_id"
    LEFT JOIN (SELECT "chain_id","pool_id", sum(amount) total FROM plugin_payouts WHERE outcome='delivered' GROUP BY "chain_id","pool_id") pp
      ON pp."chain_id"=p."chain_id" AND pp."pool_id"=p."pool_id"
    LEFT JOIN (SELECT "chain_id","pool_id", sum("net_quote") total FROM payout_pot_fundings GROUP BY "chain_id","pool_id") pcf
      ON pcf."chain_id"=p."chain_id" AND pcf."pool_id"=p."pool_id"
    LEFT JOIN (SELECT "chain_id","pool_id", sum(amount) total FROM payout_tips GROUP BY "chain_id","pool_id") tip
      ON tip."chain_id"=p."chain_id" AND tip."pool_id"=p."pool_id"
    LEFT JOIN (SELECT "chain_id","pool_id", count(*) cnt FROM bands GROUP BY "chain_id","pool_id") bnd
      ON bnd."chain_id"=p."chain_id" AND bnd."pool_id"=p."pool_id"
    LEFT JOIN (
      SELECT "chain_id","pool_id", count(*) cnt, sum("quote_proceeds") quote
      FROM milestone_harvests GROUP BY "chain_id","pool_id") hv
      ON hv."chain_id"=p."chain_id" AND hv."pool_id"=p."pool_id"
    LEFT JOIN (
      SELECT "chain_id","pool_id", sum("tokens_burned") total FROM fee_routings GROUP BY "chain_id","pool_id") frb
      ON frb."chain_id"=p."chain_id" AND frb."pool_id"=p."pool_id"
    LEFT JOIN (
      SELECT "chain_id","pool_id", sum(amount) total FROM token_burns WHERE "pool_id" IS NOT NULL GROUP BY "chain_id","pool_id") burn
      ON burn."chain_id"=p."chain_id" AND burn."pool_id"=p."pool_id"
    WHERE p."chain_id" = ${chainId};`);

  // --- candle aggregates ------------------------------------------------------
  for (const [table, col, trunc] of [
    ['pool_minute_stats', 'minute', 'minute'],
    ['pool_hour_stats', 'hour', 'hour'],
    ['pool_day_stats', 'day', 'day'],
  ] as const) {
    await tx.$executeRawUnsafe(`
      INSERT INTO ${table} (
        "chain_id","pool_id",${col},
        "open_sqrt_x96","close_sqrt_x96","high_sqrt_x96","low_sqrt_x96",
        "buy_volume_eth","sell_volume_eth","buy_volume_tokens","sell_volume_tokens",swap_count,"updated_at")
      SELECT "chain_id","pool_id", bucket,
        (array_agg("sqrt_price_x96" ORDER BY "block_number", "log_index"))[1],
        (array_agg("sqrt_price_x96" ORDER BY "block_number" DESC, "log_index" DESC))[1],
        max("sqrt_price_x96"), min("sqrt_price_x96"),
        sum(CASE WHEN is_buy THEN "amount0_eth" ELSE 0 END),
        sum(CASE WHEN is_buy THEN 0 ELSE "amount0_eth" END),
        sum(CASE WHEN is_buy THEN "amount1_tokens" ELSE 0 END),
        sum(CASE WHEN is_buy THEN 0 ELSE "amount1_tokens" END),
        count(*), now()
      FROM (
        SELECT "chain_id","pool_id", is_buy,"amount0_eth","amount1_tokens","sqrt_price_x96",
               "block_number","log_index", date_trunc('${trunc}',"timestamp") AS bucket
        FROM swaps WHERE "chain_id" = ${chainId}) s
      GROUP BY "chain_id","pool_id", bucket;`);
  }

  // day revenue (creator/protocol) layered onto the day candles
  await tx.$executeRawUnsafe(`
    INSERT INTO pool_day_stats ("chain_id","pool_id",day,"open_sqrt_x96","close_sqrt_x96","high_sqrt_x96","low_sqrt_x96",
      "creator_revenue_eth","protocol_revenue_eth","updated_at")
    SELECT "chain_id","pool_id", bucket, 0,0,0,0, creator, protocol, now()
    FROM (
      SELECT "chain_id","pool_id", date_trunc('day', t) AS bucket, sum(creator) creator, sum(protocol) protocol
      FROM (
        SELECT "chain_id","pool_id", "timestamp" t, amount creator, 0 protocol FROM creator_accruals
        UNION ALL
        SELECT "chain_id","pool_id", "timestamp" t, 0, amount FROM protocol_accruals
      ) u WHERE "chain_id" = ${chainId} GROUP BY "chain_id","pool_id", bucket
    ) agg WHERE creator > 0 OR protocol > 0
    ON CONFLICT ("chain_id","pool_id",day) DO UPDATE SET
      "creator_revenue_eth" = pool_day_stats."creator_revenue_eth" + EXCLUDED."creator_revenue_eth",
      "protocol_revenue_eth" = pool_day_stats."protocol_revenue_eth" + EXCLUDED."protocol_revenue_eth";`);

  // --- pots -------------------------------------------------------------------
  await tx.$executeRawUnsafe(`
    INSERT INTO pots ("chain_id","pool_id",balance,"funded_total","service_fee_total","updated_at")
    SELECT f."chain_id", f."pool_id", f.net - COALESCE(r.redeemed,0), f.net, f.fee, now()
    FROM (
      SELECT "chain_id","pool_id", sum("net_quote") net, sum("service_fee") fee
      FROM payout_pot_fundings WHERE "chain_id" = ${chainId} GROUP BY "chain_id","pool_id") f
    LEFT JOIN (
      SELECT "chain_id","pool_id", sum(amount) redeemed FROM payout_pot_redemptions GROUP BY "chain_id","pool_id") r
      ON r."chain_id" = f."chain_id" AND r."pool_id" = f."pool_id";`);

  // --- protocol_day_stats -------------------------------------------------------
  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_day_stats ("chain_id",day,"buy_volume_eth","sell_volume_eth",swap_count,
      "creator_revenue_eth","protocol_revenue_eth","harvest_fees_eth","graduation_count",launch_count,"updated_at")
    SELECT ${chainId}, date_trunc('day',"timestamp"),
      sum(CASE WHEN is_buy THEN "amount0_eth" ELSE 0 END),
      sum(CASE WHEN is_buy THEN 0 ELSE "amount0_eth" END),
      count(*), 0, 0, 0, 0, 0, now()
    FROM swaps WHERE "chain_id" = ${chainId}
    GROUP BY date_trunc('day',"timestamp");`);

  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_day_stats ("chain_id",day,"creator_revenue_eth","protocol_revenue_eth","harvest_fees_eth","updated_at")
    SELECT ${chainId}, d, sum(c), sum(p), sum(h), now()
    FROM (
      SELECT date_trunc('day',"timestamp") d, amount c, 0 p, 0 h FROM creator_accruals WHERE "chain_id"=${chainId}
      UNION ALL
      SELECT date_trunc('day',"timestamp") d, 0, amount, CASE WHEN source='MILESTONE_HARVEST' THEN amount ELSE 0 END FROM protocol_accruals WHERE "chain_id"=${chainId}
    ) u GROUP BY d
    ON CONFLICT ("chain_id", day) DO UPDATE SET
      "creator_revenue_eth" = protocol_day_stats."creator_revenue_eth" + EXCLUDED."creator_revenue_eth",
      "protocol_revenue_eth" = protocol_day_stats."protocol_revenue_eth" + EXCLUDED."protocol_revenue_eth",
      "harvest_fees_eth" = protocol_day_stats."harvest_fees_eth" + EXCLUDED."harvest_fees_eth";`);
  await tx.$executeRawUnsafe(`
    UPDATE protocol_day_stats SET graduation_count = src.c
    FROM (SELECT date_trunc('day',"timestamp") d, count(*)::int c FROM graduations WHERE "chain_id"=${chainId} GROUP BY d) src
    WHERE protocol_day_stats.day = src.d AND protocol_day_stats."chain_id" = ${chainId};`);
  await tx.$executeRawUnsafe(`
    UPDATE protocol_day_stats SET launch_count = src.c
    FROM (SELECT date_trunc('day',"timestamp") d, count(*)::int c FROM launches WHERE "chain_id"=${chainId} GROUP BY d) src
    WHERE protocol_day_stats.day = src.d AND protocol_day_stats."chain_id" = ${chainId};`);

  // --- protocol_stats -----------------------------------------------------------
  await tx.$executeRawUnsafe(`
    INSERT INTO protocol_stats ("chain_id","protocol_revenue_curve","protocol_revenue_swap_fees","protocol_revenue_harvest_fees","protocol_revenue_total","claimed_total","updated_at")
    SELECT ${chainId},
      COALESCE((SELECT sum(amount) FROM protocol_accruals WHERE "chain_id"=${chainId} AND source='CURVE_PROCEEDS'),0),
      COALESCE((SELECT sum(amount) FROM protocol_accruals WHERE "chain_id"=${chainId} AND source='SWAP_FEES'),0),
      COALESCE((SELECT sum(amount) FROM protocol_accruals WHERE "chain_id"=${chainId} AND source='MILESTONE_HARVEST'),0),
      COALESCE((SELECT sum(amount) FROM protocol_accruals WHERE "chain_id"=${chainId}),0),
      COALESCE((SELECT sum(amount) FROM claims WHERE "chain_id"=${chainId} AND claim_type='protocol'),0),
      now();`);

  // Swap-day volume rows missing revenue-only days are already covered; clean
  // zero-value protocol days.
  await tx.$executeRawUnsafe(`
    DELETE FROM protocol_day_stats WHERE "chain_id" = ${chainId}
      AND "buy_volume_eth" = 0 AND "sell_volume_eth" = 0 AND "creator_revenue_eth" = 0
      AND "protocol_revenue_eth" = 0 AND graduation_count = 0 AND launch_count = 0;`);
}
