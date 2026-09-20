# Löschmeier Test — Abo-Plattform

Testumgebung für eine vollständige Abo-Lösung: eigene Nutzerkonten,
PayPal-Abonnements mit automatischer Freischaltung/Sperrung, Kunden- und
Admin-Bereich. Basiert auf der bestehenden Test-App (Ordner `app/`), die
unverändert weiterläuft — es kommt eine neue Zugriffsschicht davor.

Föhr und Leck sind von diesem Projekt **nicht** betroffen und laufen
unverändert mit dem bisherigen (einfacheren) System weiter.

## Architektur

```
Kunde  →  test.roewise.com (Cloudflare Pages, liefert app/)
              │
              ├─ Login/Konto  →  Supabase Auth (E-Mail-Link)
              ├─ Zugriffsprüfung bei jeder Anfrage → Cloudflare Worker
              │                                        │
              │                                        ├─ liest/schreibt → Supabase (Datenbank, RLS)
              │                                        └─ prüft Status bei → PayPal API
              │
PayPal  →  Webhook (Zahlungsereignisse) → Cloudflare Worker → Supabase
```

- **Cloudflare Pages**: hostet die statische App (wie bisher bei Föhr/Leck)
- **Cloudflare Worker**: einziger Ort mit geheimen Schlüsseln (PayPal-Secret,
  Supabase Service-Role-Key). Prüft Webhooks, aktualisiert Abo-Status,
  beantwortet "ist dieser Kunde berechtigt?"-Anfragen der App
- **Supabase**: Nutzerkonten (E-Mail-Link-Login), Datenbank, Row Level
  Security (jeder Kunde sieht nur eigene Daten)
- **PayPal Subscriptions**: wiederkehrende Zahlung, sendet Webhooks bei
  jedem Ereignis (Zahlung, Kündigung, Fehlschlag, ...)

## Datenmodell

Siehe `db/schema.sql` — wird einmalig im Supabase SQL-Editor ausgeführt.

## Status

- [x] Repo angelegt, bestehende Test-App als Basis übernommen
- [x] Datenmodell entworfen und eingespielt (inkl. Row Level Security)
- [x] Supabase-Projekt eingerichtet (Auth, Datenbank)
- [x] PayPal-Sandbox-App + Produkt/Preisplan angelegt (1 €/Monat)
- [x] Cloudflare Worker deployt (Webhook, Zugriffsprüfung, Kündigung, täglicher Abgleich)
- [x] PayPal-Webhook eingerichtet und verifiziert
- [x] Registrierungs-/Kaufseite (`app/registrieren.html`), live auf Cloudflare Pages
- [x] **Erster kompletter Testkauf erfolgreich**: Anmeldung per E-Mail-Link →
      PayPal-Abo abgeschlossen → Webhook kam an → Status automatisch auf
      "aktiv" gesetzt — Kernfunktion des ganzen Systems bestätigt
- [x] Eigene Domain `test.roewise.com` eingerichtet (Pages + Supabase Auth)
- [x] Kundenbereich (`app/kundenbereich.html`): Abo-Status, Geräte, Kündigung
- [x] Admin-Bereich (`app/admin.html`): Übersicht, Kundenliste, sperren/entsperren/Kulanz — getestet, funktioniert
- [ ] E-Mail-Versand (Bestätigungen, Kündigung, Sperrung, ...)
- [ ] Rechtliche Seiten (Impressum/Datenschutz/AGB/Widerruf) für dieses Produkt
- [ ] Rechnungsstellung
- [ ] Weitere Testfälle (Kündigung, Zahlungsausfall, Rückerstattung, Gerätelimit, ...)
- [ ] Live-Umstellung (echtes PayPal-Konto statt Sandbox)

## Worker-Code

Liegt in `worker/`. Nicht-geheime Werte (Supabase-URL, anon-Key, PayPal
Client ID) stehen bereits in `worker/wrangler.toml`. Drei geheime Werte
fehlen noch — die trägst du direkt im Cloudflare-Dashboard ein, nie hier
im Repo oder im Chat:

- `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → service_role
- `PAYPAL_SECRET` — PayPal Developer → App → Secret (das, was du mir NICHT genannt hast)
- `PAYPAL_WEBHOOK_ID` — entsteht erst beim Einrichten des Webhooks (nächster Schritt)

## Nächste Schritte für dich

### 1. Worker bei Cloudflare anlegen und deployen
1. Auf dash.cloudflare.com einloggen (dein bestehendes Cloudflare-Konto,
   das du schon für den Wasserentnahme-Zugang-Worker nutzt)
2. "Workers & Pages" → "Create" → "Create Worker" → Name: `loeschmeier-abo-worker`
3. Im Worker-Editor: kompletten Inhalt von `worker/src/index.js`,
   `worker/src/supabase.js` und `worker/src/paypal.js` einfügen — am
   einfachsten, wenn du mir sagst, dass du bereit bist, dann gebe ich dir
   die genaue Klick-für-Klick-Anleitung für den Dashboard-Editor (der
   kennt standardmäßig nur eine Datei, dafür braucht es einen Kniff)
4. Unter "Settings" → "Variables and Secrets": die drei geheimen Werte
   oben als **Secret** eintragen (nicht als normale Variable)
5. Unter "Triggers" → "Cron Triggers": `0 3 * * *` eintragen (täglicher
   Abgleich um 3 Uhr nachts)

### 2. PayPal-Webhook einrichten
1. developer.paypal.com → deine Sandbox-App öffnen → "Add Webhook"
2. URL: `https://<deine-worker-adresse>.workers.dev/webhook/paypal`
3. Ereignisse auswählen: `BILLING.SUBSCRIPTION.ACTIVATED`,
   `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`,
   `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`,
   `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`
4. Die dabei erzeugte **Webhook ID** mir nennen (die ist nicht geheim,
   nur zur Zuordnung) — kommt dann als dritter Secret-Wert in Cloudflare

Sag Bescheid, wenn du bereit für Schritt 1 bist, dann führe ich dich durch
den Cloudflare-Editor.
