-- Separate Tarife je Feuerwehr im Amt Föhr-Amrum, für die manuelle
-- Zugangsvergabe über die Admin-Oberfläche ("Zugang manuell anlegen").
--
-- Jede Wehr bekommt einen eigenen, NICHT-öffentlichen Tarif mit eigenem
-- Geräte-Limit (max_geraete = Anzahl Fahrzeuge + Wehrführung). Preis 0,
-- da die Vergütung über den separaten Amt-Vertrag (pauschale
-- Aufwandsentschädigung) läuft, nicht über PayPal/Einzelabo.
--
-- PLATZHALTER: Die Zeilen unten sind Beispiele mit Phantasie-Werten.
-- Sobald die echte Liste der Feuerwehren feststeht (siehe Abfragebogen
-- "Wehrfuehrersitzung_Datenabfrage.pdf"), für jede echte Wehr eine Zeile
-- nach demselben Muster ergänzen bzw. die Platzhalter-Zeilen ersetzen.
-- code: kurz, nur Kleinbuchstaben/Ziffern/Bindestrich (wird in der
-- Admin-Oberfläche als "Tarif" eingetragen).

insert into tariffs (
  code, slug, bezeichnung, beschreibung, preis_cent, waehrung, intervall,
  zielgruppe, max_geraete, aktiv, oeffentlich
)
values
  ('amt-fa-wehr-platzhalter-1', 'amt-foehr-amrum-wehr-platzhalter-1',
   'Löschbärt – Feuerwehr [Name Wehr 1]',
   'Amt Föhr-Amrum – Zugang für Fahrzeuge und Wehrführung der Feuerwehr [Name Wehr 1]',
   0, 'EUR', '12_monate', 'organisation', 99, true, false),

  ('amt-fa-wehr-platzhalter-2', 'amt-foehr-amrum-wehr-platzhalter-2',
   'Löschbärt – Feuerwehr [Name Wehr 2]',
   'Amt Föhr-Amrum – Zugang für Fahrzeuge und Wehrführung der Feuerwehr [Name Wehr 2]',
   0, 'EUR', '12_monate', 'organisation', 99, true, false)

on conflict (code) do nothing;

-- Hinweis: max_geraete steht hier testweise auf 99 (Platzhalter, bewusst
-- hoch), damit beim Testen nichts blockiert. Vor dem echten Anlegen eines
-- Zugangs für eine konkrete Wehr den tatsächlichen Wert (Fahrzeuge +
-- Wehrführung) eintragen - entweder hier in der Migration vor dem
-- Ausführen anpassen, oder danach per update:
--
-- update tariffs set max_geraete = 5 where code = 'amt-fa-wehr-platzhalter-1';
