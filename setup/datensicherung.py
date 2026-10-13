#!/usr/bin/env python3
"""
Sichert alle wichtigen Tabellen aus Supabase in einen Ordner auf deinem Rechner:
Kunden, Verträge, Zahlungen, Rechnungen, Erklärungen und Protokolle. Läuft lokal,
der Schlüssel bleibt auf deinem Rechner. Nutzt dieselbe Datei wie
vertraege_uebersicht.py: setup/supabase_zugangsdaten.json.

Nutzung (z. B. einmal im Monat und nach jeder größeren Änderung):
  python setup\\datensicherung.py
  (oder Doppelklick auf Datensicherung.bat)

Ergebnis: Ordner setup/Sicherung_JJJJ-MM-TT/ mit je einer .json-Datei pro Tabelle
(vollständig) und Rechnungen.csv / Zahlungen.csv (für Excel). Der Ordner wird nie
ins Repository hochgeladen. Er enthält personenbezogene Daten: nur auf einem
geschützten Laufwerk aufbewahren. Rechnungen und Zahlungen sind steuerlich 8 Jahre
aufzubewahren.
"""

import csv
import json
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ORDNER = Path(__file__).resolve().parent
ZUGANGSDATEN_PFAD = ORDNER / "supabase_zugangsdaten.json"
SEITE = 1000

TABELLEN = [
    "customer_profiles",
    "tariffs",
    "subscriptions",
    "payments",
    "invoices",
    "devices",
    "cancellations",
    "legal_declarations",
    "legal_acceptances",
    "outbound_messages",
    "webhook_events",
    "admin_actions",
]


def lade_zugangsdaten():
    if not ZUGANGSDATEN_PFAD.exists():
        print(f"Keine Zugangsdaten gefunden: {ZUGANGSDATEN_PFAD}")
        print('Bitte Datei anlegen mit Inhalt: {"url": "...", "service_role_key": "..."}')
        sys.exit(1)
    daten = json.loads(ZUGANGSDATEN_PFAD.read_text(encoding="utf-8"))
    if not daten.get("url") or not daten.get("service_role_key"):
        print("supabase_zugangsdaten.json unvollständig (url / service_role_key fehlt).")
        sys.exit(1)
    return daten["url"].rstrip("/"), daten["service_role_key"]


def hole_tabelle(url, schluessel, name):
    zeilen = []
    start = 0
    while True:
        req = urllib.request.Request(f"{url}/rest/v1/{name}?select=*")
        req.add_header("apikey", schluessel)
        req.add_header("Authorization", "Bearer " + schluessel)
        req.add_header("Range-Unit", "items")
        req.add_header("Range", f"{start}-{start + SEITE - 1}")
        with urllib.request.urlopen(req) as resp:
            seite = json.loads(resp.read().decode("utf-8"))
        zeilen.extend(seite)
        if len(seite) < SEITE:
            return zeilen
        start += SEITE


def schreibe_csv(pfad, zeilen):
    if not zeilen:
        pfad.write_text("", encoding="utf-8-sig")
        return
    spalten = sorted({k for z in zeilen for k in z.keys()})
    with open(pfad, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(spalten)
        for z in zeilen:
            w.writerow([json.dumps(z.get(k), ensure_ascii=False) if isinstance(z.get(k), (dict, list)) else z.get(k, "") for k in spalten])


def main():
    url, schluessel = lade_zugangsdaten()
    ziel = ORDNER / f"Sicherung_{date.today().isoformat()}"
    ziel.mkdir(exist_ok=True)
    print("Sichere nach:", ziel)
    fehlgeschlagen = []
    for name in TABELLEN:
        try:
            zeilen = hole_tabelle(url, schluessel, name)
        except urllib.error.HTTPError as e:
            print(f"  {name}: übersprungen (HTTP {e.code})")
            fehlgeschlagen.append(name)
            continue
        (ziel / f"{name}.json").write_text(json.dumps(zeilen, ensure_ascii=False, indent=1), encoding="utf-8")
        if name == "invoices":
            schreibe_csv(ziel / "Rechnungen.csv", zeilen)
        if name == "payments":
            schreibe_csv(ziel / "Zahlungen.csv", zeilen)
        print(f"  {name}: {len(zeilen)} Zeilen")
    print()
    if fehlgeschlagen:
        print("Nicht gesichert:", ", ".join(fehlgeschlagen))
        print("Das kann bei Tabellen vorkommen, die es in deinem Projekt nicht gibt. Fehlen")
        print("invoices oder payments, bitte melden.")
    else:
        print("Fertig. Alle Tabellen gesichert.")


if __name__ == "__main__":
    main()
