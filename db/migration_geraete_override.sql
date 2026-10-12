-- Individuelles Geräte-Limit je Vertrag. Überschreibt max_geraete des Tarifs.
-- Damit bekommt z.B. eine Feuerwehr eine E-Mail-Adresse mit mehr als zwei
-- Geräten, ohne dass für jede Wehr ein eigener Tarif nötig ist.
-- NULL = Wert des Tarifs gilt. Im Supabase SQL-Editor einmalig ausführen,
-- BEVOR der Worker mit dieser Änderung deployt wird.

alter table subscriptions
  add column if not exists max_geraete_override integer
  check (max_geraete_override is null or (max_geraete_override between 1 and 500));
