#!/usr/bin/env python3
"""
Legt einmalig ein PayPal-Produkt + einen jährlich wiederkehrenden Preisplan
in der Sandbox an ("Löschbärt Föhr", 12 EUR/Jahr). Läuft lokal bei dir - dein PayPal-Secret
bleibt auf deinem Rechner und wird nirgendwo hochgeladen.

Vorbereitung:
  1. Datei setup/paypal_zugangsdaten.json anlegen (wird nie eingecheckt):
     {"client_id": "...", "secret": "..."}
     Client ID und Secret findest du bei developer.paypal.com unter
     Apps & Credentials -> Sandbox -> deine App.

Nutzung:
  python3 setup/paypal_plan_erstellen.py

Am Ende wird eine Plan-ID ausgegeben (Format P-XXXXXXXXXXXXXXXXXXXX).
Die ist NICHT geheim - die brauche ich, um den Kauf-Button zu bauen.
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ZUGANGSDATEN_PFAD = Path(__file__).resolve().parent / "paypal_zugangsdaten.json"
API_BASE = "https://api-m.sandbox.paypal.com"


def anfrage(pfad, methode="GET", body=None, token=None, auth=None):
    url = API_BASE + pfad
    daten = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=daten, method=methode)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if auth:
        import base64
        b64 = base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
        req.add_header("Authorization", f"Basic {b64}")
    try:
        with urllib.request.urlopen(req) as resp:
            inhalt = resp.read()
            return json.loads(inhalt) if inhalt else {}
    except urllib.error.HTTPError as e:
        print(f"Fehler bei {pfad}: {e.code}")
        print(e.read().decode("utf-8", errors="replace"))
        sys.exit(1)


def main():
    if not ZUGANGSDATEN_PFAD.exists():
        print(f"Keine Zugangsdaten gefunden: {ZUGANGSDATEN_PFAD}")
        print('Bitte Datei anlegen mit Inhalt: {"client_id": "...", "secret": "..."}')
        sys.exit(1)

    zugang = json.loads(ZUGANGSDATEN_PFAD.read_text(encoding="utf-8"))

    print("Hole Zugriffstoken ...")
    # grant_type=client_credentials muss als Formulardaten gesendet werden,
    # nicht als JSON - deshalb hier abweichend von anfrage():
    import base64
    b64 = base64.b64encode(f"{zugang['client_id']}:{zugang['secret']}".encode()).decode()
    req = urllib.request.Request(
        API_BASE + "/v1/oauth2/token",
        data=b"grant_type=client_credentials",
        method="POST",
    )
    req.add_header("Authorization", f"Basic {b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as resp:
        token = json.loads(resp.read())["access_token"]

    print("Lege Produkt an ...")
    produkt = anfrage(
        "/v1/catalogs/products",
        methode="POST",
        body={
            "name": "Löschbärt Föhr",
            "description": "Digitale Wasserentnahmestellen- und Defibrillatorenkarte für Föhr",
            "type": "SERVICE",
            "category": "SOFTWARE",
        },
        token=token,
    )
    produkt_id = produkt["id"]
    print(f"  Produkt-ID: {produkt_id}")

    print("Lege Preisplan an (12 EUR / Jahr, automatische Verlängerung) ...")
    plan = anfrage(
        "/v1/billing/plans",
        methode="POST",
        body={
            "product_id": produkt_id,
            "name": "Löschbärt Föhr – Jahreszugang",
            "description": "12 EUR pro Jahr; nach zwoelf Monaten Mindestlaufzeit jederzeit kuendbar",
            "billing_cycles": [
                {
                    "frequency": {"interval_unit": "YEAR", "interval_count": 1},
                    "tenure_type": "REGULAR",
                    "sequence": 1,
                    "total_cycles": 0,
                    "pricing_scheme": {
                        "fixed_price": {"value": "12.00", "currency_code": "EUR"}
                    },
                }
            ],
            "payment_preferences": {
                "auto_bill_outstanding": True,
                "payment_failure_threshold": 1,
            },
        },
        token=token,
    )
    plan_id = plan["id"]
    print(f"\nFertig! Plan-ID: {plan_id}")
    print("Diese Plan-ID bitte an Claude weitergeben (nicht geheim).")


if __name__ == "__main__":
    main()
