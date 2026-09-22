#!/usr/bin/env python3
"""
Zeigt eine lesbare Übersicht aller Verträge: E-Mail, Vertragsnummer, Datum,
Status in Klartext - ohne kryptische IDs. Läuft lokal bei dir, dein
Supabase-Schlüssel bleibt auf deinem Rechner und wird nirgendwo hochgeladen.

Vorbereitung (einmalig):
  1. Datei setup/supabase_zugangsdaten.json anlegen (wird nie eingecheckt):
     {"url": "https://bmntahgtagjijfyeepju.supabase.co", "service_role_key": "..."}
     Die URL steht in Cloudflare unter SUPABASE_URL. Den service_role_key
     findest du im Supabase-Dashboard unter Project Settings -> API ->
     "service_role" (NICHT der "anon" Key - dieser hier sieht ALLES,
     niemals in ein Repo oder an Dritte weitergeben).

Nutzung:
  python3 setup/vertraege_uebersicht.py
  (oder Doppelklick auf Vertraege_anzeigen.bat)

Zeigt zusätzlich, ganz unten, eine Liste der letzten Kündigungen und
Widerrufe mit Bearbeitungsstatus - genau dort steht z.B., ob eine
Erstattung geklappt hat oder manuell geprüft werden muss.
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

ZUGANGSDATEN_PFAD = Path(__file__).resolve().parent / "supabase_zugangsdaten.json"

STATUS_TEXT = {
    "unbezahlt": "Noch nicht bezahlt",
    "wird_geprueft": "Zahlung wird geprüft",
    "wartet_auf_leistungsbeginn": "Bezahlt, Leistungsbeginn steht bevor",
    "aktiv": "Aktiv",
    "ueberfaellig": "Zahlung überfällig",
    "kulanzzeit": "Kulanzzeit, Zahlungsmethode prüfen",
    "gekuendigt_zum_ende": "Gekündigt, läuft bis Vertragsende",
    "gesperrt": "Gesperrt",
    "manuell_gesperrt": "Gesperrt (manuell)",
    "abgelaufen": "Abgelaufen",
    "erstattet": "Erstattet",
    "widerrufen": "Widerrufen",
}

VERARBEITUNG_TEXT = {
    "eingegangen": "Eingegangen, wird noch verarbeitet",
    "zugeordnet": "Zugeordnet, verarbeitet",
    "manuelle_pruefung": "Nicht automatisch zugeordnet - bitte prüfen",
    "paypal_pruefung_noetig": "PayPal-Kündigung fehlgeschlagen - bitte prüfen",
    "erstattung_manuell_pruefen": "Erstattung fehlgeschlagen - bitte prüfen",
    "anteilig_erstattet": "Anteilig erstattet",
    "erstattet": "Vollständig erstattet",
    "keine_zahlung_gefunden": "Keine Zahlung gefunden - bitte prüfen",
    "verarbeitung_fehlgeschlagen_manuell_pruefen": "Fehler bei der Verarbeitung - bitte prüfen",
}


def klartext(wert, zuordnung):
    return zuordnung.get(wert, wert or "-")


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


def abfrage(basis_url, schluessel, pfad):
    req = urllib.request.Request(
        f"{basis_url}/rest/v1/{pfad}",
        headers={
            "apikey": schluessel,
            "Authorization": f"Bearer {schluessel}",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Fehler bei der Abfrage ({e.code}): {e.read().decode('utf-8', errors='replace')}")
        sys.exit(1)


def datum_kurz(wert):
    if not wert:
        return "-"
    return str(wert)[:10]


def main():
    basis_url, schluessel = lade_zugangsdaten()

    print("Lade Verträge ...")
    abos = abfrage(
        basis_url, schluessel,
        "subscriptions?select=vertragsnummer,status,erstellt_am,bezahlt_bis,"
        "kuendigungswirksam_am,customer_profiles(email)"
        "&order=erstellt_am.desc",
    )

    print()
    print(f"{'Vertragsnummer':<24}{'E-Mail':<32}{'Erstellt':<12}{'Status':<38}{'Bezahlt bis':<12}")
    print("-" * 118)
    for abo in abos:
        email = (abo.get("customer_profiles") or {}).get("email", "-")
        print(
            f"{(abo.get('vertragsnummer') or '-'):<24}"
            f"{email:<32}"
            f"{datum_kurz(abo.get('erstellt_am')):<12}"
            f"{klartext(abo.get('status'), STATUS_TEXT):<38}"
            f"{datum_kurz(abo.get('bezahlt_bis')):<12}"
        )
    print(f"\nGesamt: {len(abos)} Verträge")

    print("\n\nLetzte Kündigungen und Widerrufe")
    erklaerungen = abfrage(
        basis_url, schluessel,
        "legal_declarations?select=typ,vertragsreferenz,email,eingegangen_am,"
        "verarbeitungsstatus,zugeordnet,wirksam_zum"
        "&order=eingegangen_am.desc&limit=50",
    )
    print()
    print(f"{'Art':<12}{'Vertragsref.':<24}{'E-Mail':<32}{'Eingegangen':<12}{'Bearbeitung':<45}")
    print("-" * 125)
    for e in erklaerungen:
        art = "Widerruf" if e.get("typ") == "widerruf" else "Kündigung"
        print(
            f"{art:<12}"
            f"{(e.get('vertragsreferenz') or '-'):<24}"
            f"{(e.get('email') or '-'):<32}"
            f"{datum_kurz(e.get('eingegangen_am')):<12}"
            f"{klartext(e.get('verarbeitungsstatus'), VERARBEITUNG_TEXT):<45}"
        )
    print(f"\nGesamt: {len(erklaerungen)} Erklärungen (letzte 50)")


if __name__ == "__main__":
    main()
