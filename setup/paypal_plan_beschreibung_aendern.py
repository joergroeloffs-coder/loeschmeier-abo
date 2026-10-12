#!/usr/bin/env python3
"""
Ändert den Beschreibungstext eines bestehenden PayPal-Plans (z. B. nach einer
Änderung der Kündigungsbedingungen). Preis und Zyklus bleiben unverändert.

Nutzung:
  python3 setup/paypal_plan_beschreibung_aendern.py P-XXXXXXXXXXXXXXXXXXXX        (Sandbox)
  python3 setup/paypal_plan_beschreibung_aendern.py P-XXXXXXXXXXXXXXXXXXXX live   (Live)

Zugangsdaten stehen in setup/paypal_zugangsdaten.json (wird nie eingecheckt).
"""

import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BESCHREIBUNG = "10 EUR pro Jahr; 12 Monate Mindestlaufzeit, danach unbefristet und mit einem Monat Frist kuendbar"
ZUGANGSDATEN_PFAD = Path(__file__).resolve().parent / "paypal_zugangsdaten.json"


def main():
    if len(sys.argv) < 2 or not sys.argv[1].startswith("P-"):
        print("Bitte die Plan-ID angeben, z. B.: python3 setup/paypal_plan_beschreibung_aendern.py P-XXXX live")
        sys.exit(1)
    plan_id = urllib.parse.quote(sys.argv[1], safe="")
    live = len(sys.argv) > 2 and sys.argv[2] == "live"
    basis = "https://api-m.paypal.com" if live else "https://api-m.sandbox.paypal.com"
    assert len(BESCHREIBUNG) <= 127, "Beschreibung zu lang fuer PayPal"
    print("MODUS:", "LIVE (echtes Geld)" if live else "Sandbox")

    zugang = json.loads(ZUGANGSDATEN_PFAD.read_text(encoding="utf-8"))
    roh = base64.b64encode(f"{zugang['client_id']}:{zugang['secret']}".encode()).decode()
    req = urllib.request.Request(basis + "/v1/oauth2/token", data=b"grant_type=client_credentials", method="POST")
    req.add_header("Authorization", f"Basic {roh}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as resp:
        token = json.loads(resp.read())["access_token"]

    patch = json.dumps([{"op": "replace", "path": "/description", "value": BESCHREIBUNG}]).encode("utf-8")
    req = urllib.request.Request(f"{basis}/v1/billing/plans/{plan_id}", data=patch, method="PATCH")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            print("Fertig, PayPal-Antwort:", resp.status)
    except urllib.error.HTTPError as e:
        print("Fehler:", e.code)
        print(e.read().decode("utf-8", errors="replace"))
        sys.exit(1)

    pruefen = urllib.request.Request(f"{basis}/v1/billing/plans/{plan_id}")
    pruefen.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(pruefen) as resp:
        print("Neue Beschreibung:", json.loads(resp.read()).get("description"))


if __name__ == "__main__":
    main()
