-- Holder indexing (token_holders folded by the substreams db_out) and the
-- swaps.trader column (transaction signer, for per-wallet PnL). The substreams
-- schema.sql owns the sink-side table; this migration aligns the sink-managed
-- `public.swaps` table and adds the realtime comments trigger.

ALTER TABLE public."swaps" ADD COLUMN IF NOT EXISTS "trader" VARCHAR(42) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "swaps_trader_time_idx" ON public."swaps"("trader", "timestamp" DESC);

-- Comments realtime: same notify-only, exception-guarded pattern as trades.
CREATE OR REPLACE FUNCTION notify_spawn_comment() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM pg_notify('spawn_comments', json_build_object(
      'comment_id', NEW.id::text,
      'token_db_id', NEW."tokenDbId"::text,
      'wallet', NEW."walletAddress",
      'root_id', NEW."rootId"::text,
      'depth', NEW.depth,
      'ts', EXTRACT(epoch FROM NEW."createdAt")::bigint
    )::text);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_spawn_comment ON backend."comments";
CREATE TRIGGER trg_notify_spawn_comment AFTER INSERT ON backend."comments"
  FOR EACH ROW EXECUTE FUNCTION notify_spawn_comment();
