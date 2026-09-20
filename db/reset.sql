-- Einmalig VOR schema.sql ausführen, falls schema.sql schon einmal
-- (auch nur teilweise) gelaufen ist. Löscht alle Tabellen dieses Projekts,
-- damit schema.sql sauber neu aufbauen kann. Betrifft nur die hier
-- angelegten Tabellen, nicht dein Supabase-Projekt selbst.

drop table if exists cancellations cascade;
drop table if exists security_events cascade;
drop table if exists admin_actions cascade;
drop table if exists notifications cascade;
drop table if exists webhook_events cascade;
drop table if exists sessions cascade;
drop table if exists devices cascade;
drop table if exists invoices cascade;
drop table if exists payments cascade;
drop table if exists subscriptions cascade;
drop table if exists tariffs cascade;
drop table if exists customer_profiles cascade;
