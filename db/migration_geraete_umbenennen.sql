-- Migration: trennt die technische Geraete-Kennung (aus localStorage,
-- unveraenderlich, dient dem Abgleich beim Zugriff) von einem vom Kunden
-- vergebbaren Anzeigenamen. Vorher wurde geraet_name fuer beides
-- missbraucht, wodurch ein Umbenennen den Geraete-Abgleich zerstoert haette.
-- Einmalig im Supabase SQL-Editor ausfuehren.

alter table devices add column geraet_kennung text;
update devices set geraet_kennung = geraet_name where geraet_kennung is null;
alter table devices alter column geraet_kennung set not null;
create unique index devices_customer_kennung_key on devices (customer_id, geraet_kennung);

-- Bestehende Eintraege trugen die technische Kennung faelschlich als Namen;
-- Anzeige faellt jetzt auf "Unbekanntes Geraet" zurueck, bis umbenannt wird.
update devices set geraet_name = null;
