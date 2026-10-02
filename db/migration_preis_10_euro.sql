-- Preisänderung Jahresabo "foehr-jahr": auf 10,00 € pro Jahr.
-- Ersetzt migration_preis_6_euro.sql (der 6-Euro-Preis wurde nie in der
-- Datenbank übernommen - daher zeigte die registrieren.html, die den Preis
-- live aus der Datenbank liest, noch den alten Preis, während die anderen,
-- fest im HTML stehenden Seiten schon 6,00 € zeigten).
--
-- Im Supabase SQL-Editor einmalig ausführen. Wirkt sich auf neue
-- Bestellungen aus; bestehende Abos behalten ihren vereinbarten Preis,
-- bis sie sich zum nächsten Fälligkeitstermin verlängern.

update tariffs
set preis_cent = 1000
where code = 'foehr-jahr';
