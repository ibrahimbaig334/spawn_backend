-- Live milestone-harvest notifications: same notify-only, exception-guarded
-- pattern as the trade/pool triggers. The broadcaster relays these as
-- {type:"harvest"} WS events for payout toasts.

CREATE OR REPLACE FUNCTION notify_spawn_harvest() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM pg_notify('spawn_harvests', json_build_object(
      'pool_id', NEW."pool_id",
      'chain_id', NEW."chain_id",
      'band_index', NEW."band_index"::bigint,
      'gross_quote', NEW."quote_proceeds"::text,
      'ts', EXTRACT(epoch FROM NEW."timestamp")::bigint
    )::text);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_spawn_harvest ON public.milestone_harvests;
CREATE TRIGGER trg_notify_spawn_harvest AFTER INSERT ON public.milestone_harvests
  FOR EACH ROW EXECUTE FUNCTION notify_spawn_harvest();
