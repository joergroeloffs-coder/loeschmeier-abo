-- Preisänderung Jahresabo "foehr-jahr": 12,00 € -> 6,00 € pro Jahr.
-- Im Supabase SQL-Editor einmalig ausführen. Wirkt sich auf neue
-- Bestellungen aus; bestehende Abos behalten ihren vereinbarten Preis,
-- bis sie sich zum nächsten Fälligkeitstermin verlängern.

update tariffs
set preis_cent = 600
where code = 'foehr-jahr';
