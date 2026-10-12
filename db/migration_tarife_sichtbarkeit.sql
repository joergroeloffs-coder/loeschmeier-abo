-- Tarife: nicht-öffentliche Tarife (z.B. je Feuerwehr) sind bisher für jeden
-- sichtbar, der den öffentlichen Supabase-Schlüssel kennt (Policy prüfte nur
-- "aktiv"). Künftig sehen anonyme Besucher nur öffentliche Tarife; eingeloggte
-- Kunden zusätzlich den Tarif ihres eigenen Vertrags (für die Anzeige im
-- Kundenbereich). Im Supabase SQL-Editor einmalig ausführen; der Worker nutzt
-- den Service-Key und ist davon nicht betroffen.

drop policy if exists "tarife_oeffentlich_lesbar" on tariffs;
create policy "tarife_oeffentlich_lesbar" on tariffs
  for select using (
    aktiv = true
    and (
      oeffentlich = true
      or id in (
        select s.tariff_id from subscriptions s
        join customer_profiles c on c.id = s.customer_id
        where c.auth_user_id = auth.uid()
      )
    )
  );
