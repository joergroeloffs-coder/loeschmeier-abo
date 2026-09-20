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
- [x] Datenmodell entworfen
- [ ] Supabase-Projekt (**dein nächster Schritt**, siehe unten)
- [ ] PayPal-Sandbox-App (**dein nächster Schritt**, siehe unten)
- [ ] Cloudflare Worker: Webhook-Verarbeitung
- [ ] Cloudflare Worker: Zugriffsprüfung
- [ ] Login/Kundenbereich in der App
- [ ] Admin-Bereich
- [ ] E-Mail-Versand
- [ ] Verkaufsseite
- [ ] Tests in der Sandbox
- [ ] Live-Umstellung

## Nächste Schritte für dich (unvermeidbar manuell)

### 1. Supabase-Projekt anlegen
1. Auf supabase.com kostenlos registrieren
2. "New Project" → Name z.B. `loeschmeier-test`, Region `Frankfurt (eu-central-1)`
3. Ein Datenbank-Passwort wird generiert — das brauche ich NICHT, das bleibt bei dir
4. Nach Erstellung: im Menü "SQL Editor" öffnen, Inhalt von `db/schema.sql`
   einfügen und ausführen
5. Im Menü "Project Settings" → "API": mir bitte **nur** die "Project URL"
   und den **"anon public"**-Key nennen (nicht den "service_role"-Key — der
   ist geheim und kommt später direkt in Cloudflare, nie in den Chat)

### 2. PayPal-Entwickler-App (Sandbox)
1. Auf developer.paypal.com mit deinem PayPal-Business-Konto einloggen
2. "Apps & Credentials" → Reiter "Sandbox" → "Create App"
3. Name z.B. `loeschmeier-test`
4. Mir bitte **nur** die "Client ID" nennen (nicht den "Secret" — der kommt
   später direkt in Cloudflare, nie in den Chat)
5. Unter "Sandbox" → "Accounts" prüfen, ob ein Test-Käufer-Konto existiert
   (wird meist automatisch angelegt) — für spätere Testkäufe

Sobald diese beiden Punkte stehen, baue ich den Cloudflare Worker und die
Login-/Kundenbereich-Seiten.
