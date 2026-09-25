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

Läuft automatisch: jeder Push nach `main`, der etwas unter `worker/` ändert,
deployt über GitHub Actions (`.github/workflows/deploy-worker.yml`) direkt
zu Cloudflare. Kein manuelles Kopieren mehr in den Dashboard-Code-Editor.

Einmalige Einrichtung (nur einmal nötig):

1. In `wrangler.toml` den `[[kv_namespaces]]`-Block für `RATE_KV` aktivieren
   (ID aus dem Cloudflare-Dashboard, siehe Kommentar dort) und committen —
   die ID ist nicht geheim.
2. Cloudflare-Dashboard → Mein Profil → API-Tokens → Token erstellen, mit
   Berechtigung "Workers Scripts bearbeiten" für das betroffene Konto.
3. GitHub-Repo → Settings → Secrets and variables → Actions → New repository
   secret:
   - `CLOUDFLARE_API_TOKEN`: der eben erstellte Token
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare-Dashboard, rechte Seitenleiste

Ohne diese Secrets schlägt der Workflow beim nächsten Push fehl (Fehlermeldung
ist im GitHub-Actions-Tab sichtbar) — der Worker bleibt dann einfach auf dem
zuletzt erfolgreich deployten Stand.

Für einen Deploy von der eigenen Maschine aus (z.B. wenn GitHub Actions
gerade nicht erreichbar ist) weiterhin möglich:

```bash
cd worker
npm install
npx wrangler login   # einmalig, öffnet den Browser
npm run deploy
```

`worker/dist/bundle.js` und `build_bundle.py` sind nur noch ein Fallback für
den Fall, dass weder GitHub Actions noch Wrangler nutzbar sind.

Die Rechtstexte sind auf den derzeit umgesetzten Ablauf zugeschnitten, ersetzen
aber keine individuelle anwaltliche und steuerliche Prüfung vor einem Livegang.
