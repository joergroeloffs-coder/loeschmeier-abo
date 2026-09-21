-- Erst ausführen, nachdem setup/paypal_plan_erstellen.py den neuen festen
-- 12-Euro-Jahresplan erzeugt hat. Den Platzhalter vorher ersetzen.
do $$
declare
  neue_plan_id text := 'HIER_NEUE_PAYPAL_PLAN_ID_EINTRAGEN';
begin
  if neue_plan_id = 'HIER_NEUE_PAYPAL_PLAN_ID_EINTRAGEN' then
    raise exception 'PayPal-Plan-ID wurde noch nicht eingetragen';
  end if;

  update tariffs
  set paypal_plan_id = neue_plan_id
  where code = 'foehr-jahr';
end;
$$;
