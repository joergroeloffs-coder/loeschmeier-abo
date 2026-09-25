# Löschbärt Föhr – Verkaufsplattform

Verkaufs-, Vertrags- und Zugangsverwaltung für den privaten Föhr-Jahreszugang.
Der Zugang kostet 12 Euro pro Jahr und ist auf zwei Geräte begrenzt. Nach zwölf
Monaten Mindestlaufzeit läuft der Vertrag unbefristet weiter; ab dann kann
jederzeit gekündigt werden und vorausbezahlte Restzeit wird anteilig erstattet.
Eine deaktivierte Tarifvorlage hält den späteren Ausbau für Gemeinde- und
Feuerwehrverträge offen.

Die Leck-Version ist nicht Bestandteil dieses Projekts.

## Aufbau

- `app/`: Registrieren, Bestellen, Kundenbereich, Kündigung, Widerruf,
  Rechnungen und Rechtstexte
- `worker/`: serverseitige PayPal-Prüfung, Webhooks, Zugangsprüfung,
  E-Mail-Warteschlange und Admin-API
- `db/schema.sql`: bisheriges Basisschema
- `db/migration_sales_platform.sql`: Erweiterung für den Föhr-Verkauf
- `setup/paypal_plan_erstellen.py`: erzeugt einen PayPal-Sandboxplan mit
  genau einem Jahreszyklus zu 12 Euro

## Schutz vor versehentlichem Verkauf

`SALES_ENABLED` steht in `worker/wrangler.toml` standardmäßig auf `false`.
Der Kaufbutton erscheint erst, wenn zusätzlich ein PayPal-Plan am öffentlichen
Tarif hinterlegt ist und `RESEND_API_KEY` sowie `TRANSACTIONAL_FROM` vorhanden
sind. Erst nach vollständigem Sandbox-Test darf `SALES_ENABLED` auf `true`
gesetzt werden.

## Einmalige Einrichtung

1. `db/migration_sales_platform.sql` im Supabase SQL-Editor ausführen.
2. Mit `setup/paypal_plan_erstellen.py` einen neuen Sandboxplan erzeugen.
3. Dessen Plan-ID beim Tarif `foehr-jahr` in `tariffs.paypal_plan_id` eintragen.
4. Worker deployen und Secrets setzen:
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `PAYPAL_SECRET`
   - `PAYPAL_WEBHOOK_ID`
   - `RESEND_API_KEY`
5. KV-Binding `RATE_KV` für Admin-Login und öffentliche Rechtserklärungen
   anbinden.
6. In Supabase Auth die Redirect-URL `https://foehr.roewise.com/nutzer/`
   freigeben.
7. PayPal-Webhooks für Aktivierung, Zahlung, Zahlungsausfall, Kündigung,
   Sperrung, Ablauf und Erstattung auf `/webhook/paypal` einrichten.
8. Sandbox-Testmatrix vollständig durchführen; erst danach Verkauf aktivieren.

## Pflicht-Tests vor Livegang

- Bestellung mit sofortigem und verzögertem Leistungsbeginn
- falscher PayPal-Plan, fremde `custom_id`, falscher Betrag und falsche Währung
- doppelter Webhook und vorübergehender Datenbankfehler
- Kündigung angemeldet und über die öffentliche Kündigungsseite
- Widerruf zugeordnet und nicht automatisch zuordenbar
- zwei Geräte erlaubt, drittes Gerät gesperrt, Gerät wieder entfernen
- Vertragsende, Zahlungsausfall, Erstattung und ausgefallene Transaktions-E-Mail
- Rechnung als Kleinbetragsrechnung und lückenfreie Rechnungsnummern

## Entwicklung

```bash
cd worker
npm test
```

## Deploy

Einmalig einrichten:

```bash
cd worker
npm install
npx wrangler login   # öffnet den Browser, verknüpft die CLI mit dem Cloudflare-Konto
```

Danach in `wrangler.toml` den `[[kv_namespaces]]`-Block für `RATE_KV`
aktivieren (ID aus dem Dashboard, siehe Kommentar dort).

Ab dann für jedes Deploy:

```bash
npm run deploy
```

Das führt automatisch die Tests aus und deployt danach direkt über die
Cloudflare-API — kein manuelles Kopieren mehr in den Dashboard-Code-Editor.
`worker/dist/bundle.js` und `build_bundle.py` sind nur noch ein Fallback für
den Fall, dass `npx wrangler login` einmal nicht möglich ist.

Die Rechtstexte sind auf den derzeit umgesetzten Ablauf zugeschnitten, ersetzen
aber keine individuelle anwaltliche und steuerliche Prüfung vor einem Livegang.
