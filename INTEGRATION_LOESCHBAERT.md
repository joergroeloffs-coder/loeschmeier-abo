# Integration Löschbärt – Bericht

Stand: 21. September 2026
Branch: `claude/integration-loeschbaert` (aufgesetzt auf `codex/verkaufsplattform-foehr`)

Dieser Bericht gilt für alle drei Projekte. Die beiden anderen Repositories
verweisen hierher.

> **Keine Rechtsberatung.** Die Umsetzung folgt dem, was technisch sauber
> herstellbar ist. Ob sie im Einzelfall genügt, kann nur eine auf IT-,
> Vertrags- und Datenschutzrecht spezialisierte Rechtsanwältin oder ein
> entsprechender Rechtsanwalt beurteilen; für die steuerliche Behandlung gilt
> dasselbe für die Steuerberatung. Die Bezeichnung „rechtssicher" wird hier
> bewusst nicht verwendet.

---

## 1. Was übernommen wurde und warum

Grundlage sind in allen drei Projekten die Codex-Branches. Sie waren dem
jeweiligen `main`-Stand sachlich überlegen:

| Bereich | Warum Codex |
|---|---|
| Tarif | Jahreszugang 12,00 €, Mindestlaufzeit, anteilige Erstattung statt Monatsabo |
| PayPal | serverseitige Prüfung von Plan, Status, Betrag, Währung und Kontobindung über `custom_id` |
| Rechnungsnummern | Datenbanksequenz mit Sperre statt „höchste Nummer plus eins" im Anwendungscode |
| Webhooks | Fehler liefern jetzt einen Fehlerstatus, damit PayPal erneut zustellt |
| E-Mail | Warteschlange mit Wiederholung statt Versand ohne Nachweis |
| Verkaufssperre | `SALES_ENABLED` |
| Rechtstexte | AGB, Widerruf, Datenschutz inhaltlich deutlich vollständiger |
| Zugriffsschutz | echte Vertragsprüfung statt lokaler Testphase mit `?freigabe=1` |

Nicht übernommen wurde nichts pauschal: Jede Datei wurde gelesen und die
folgenden Punkte wurden korrigiert.

## 2. Was an der Codex-Fassung korrigiert wurde

### Sicherheit

| Befund | Korrektur |
|---|---|
| CORS stand weiterhin auf `*` | Freigabe nur für die eigenen Domains; die Kopfzeilen werden erst auf die fertige Antwort gesetzt, damit bei gleichzeitigen Anfragen kein fremder Ursprung durchschlagen kann |
| `body.device_id`, `subscription_id`, `customer_id` gingen ungeprüft in den Datenbankfilter | UUID-Prüfung und durchgängige Kodierung aller Filterwerte |
| Tarifcode und PayPal-Abo-Kennung ungeprüft | Formatprüfung |
| Gerätekennung beliebig | nur UUID-Format wird akzeptiert |
| Gerätelimit fest auf 2 | kommt jetzt aus der Tarifspalte `max_geraete` |
| Admin-Gerätereset baute die Adresse von Hand zusammen | nutzt den geprüften Datenbankzugang |
| keine Schutzkopfzeilen | `nosniff`, `Referrer-Policy`, `Cache-Control: no-store` auf allen API-Antworten |

### Recht

| Befund | Korrektur |
|---|---|
| Letzter Bestellschritt war der PayPal-Button („Bezahlen") | eigene Schaltfläche **„Zahlungspflichtig abonnieren"**; PayPal folgt erst danach als reiner Zahlungsschritt (§ 312j Abs. 3 BGB) |
| Pflichtangaben verstreut | **Bestellübersicht** unmittelbar vor der Bestellung: Leistung, Gesamtpreis, § 19 UStG, Zahlungsweise, Laufzeit, Verlängerung, Kündigung, Gerätezahl, Voraussetzungen, Anbieter, Unterlagen |
| Leistungsbeginn war vorausgewählt | muss aktiv gewählt werden; keine vorangekreuzten Felder |
| Kündigung und Widerruf sendeten sofort ab | **Zusammenfassung vor dem Absenden**, danach eindeutig beschriftete Bestätigungsschaltfläche |
| „frühestmöglicher Zeitpunkt" nur implizit | ausdrückliche Wahl zwischen frühestmöglich und Wunschdatum |
| Erklärung wurde **nach** der Verarbeitung gespeichert | wird **zuerst** gespeichert; Fehler bei PayPal, Datenbank oder Versand können den Eingang nicht mehr verlieren |
| niemand erfuhr von liegengebliebenen Fällen | Betreiber-Benachrichtigung zu jeder Erklärung |

### Marke

| Befund | Korrektur |
|---|---|
| Vertragsnummern begannen mit `LM-` (Löschmeier), für Kunden sichtbar | jetzt `LB-` |
| Tarif-Slugs `loeschmeier-foehr-privat`, `loeschmeier-gemeinde` | `loeschbaert-…` |
| Seitentitel „Einzelabo – Roewise" | „Löschbärt Föhr – Jahreszugang" |

### Bedienbarkeit und Robustheit

- Fällt die Anmeldebibliothek oder PayPal aus, erscheint eine verständliche
  Meldung statt eines stumm abgebrochenen Skripts.
- Rechtstexte liefen auf schmalen Bildschirmen aus dem Bild (Überschrift
  „Allgemeine Geschäftsbedingungen"); behoben.
- Sichtbare Fokusmarkierung, `fieldset`/`legend` für Auswahlgruppen,
  `aria-live` für Statusmeldungen.


### 2.1 Nachtrag: zweite App-Kopie mit schwachem Schutz

Bei der Endkontrolle fiel auf, dass dieses Repository unter `app/nutzer/` und
`app/nutzer-admin/` eine **zweite Kopie der Anwendung** enthält, die unter
`test.roewise.com` ausgeliefert wird. Sie benutzte weiterhin die alte
`app/zugriffspruefung.js` mit einer Offline-Gnadenfrist aus dem
Browserspeicher. Diese Fassung gab die App frei, sobald der Eintrag
`loeschmeier_abo_zugriff_bis` in der Zukunft lag – ein Wert, den jede Person
im Browser selbst setzen kann. Damit war das Produkt über die Testadresse
ohne Vertrag vollständig nutzbar, obwohl die Hauptanwendung inzwischen
serverseitig geschützt war.

`app/zugriffspruefung.js` enthält jetzt denselben serverseitigen Schutz wie
`wasserentnahme-foehr/zugangsschutz.js`. Die Gnadenfrist ist ersatzlos
entfallen, und die Einbindung wurde hinter `config.js` verschoben, weil der
Schutz die Konfiguration braucht.

Geprüft im Browser (`test/browser/testkopie-zugriff.test.js`): Ein gesetzter
`loeschmeier_abo_zugriff_bis`-Eintrag zusammen mit `?freigabe=1` öffnet die
Testkopie nicht mehr; ohne Anmeldung bleibt sie gesperrt; mit gültigem Abo
lädt sie normal.


### 2.2 Nachtrag: Datenpflege-Werkzeug war weiterhin offen

Beim ersten Aufruf nach der Veröffentlichung fiel auf, dass
`app/verwaltung.html` – das Werkzeug zum Pflegen der Stellendaten – **ohne
jede Anmeldung erreichbar** war. In `wasserentnahme-foehr` hatte ich die
entsprechende Seite geschützt, die Entsprechung in diesem Repository aber
übersehen. Die Seite war damit unter `test.roewise.com/verwaltung` öffentlich.

Behoben:

- `verwaltung.html` und `nutzer-admin/` verlangen jetzt ein vom Server
  bestätigtes Betreiberkonto.
- Die Schutzstufe steht als Attribut am Skript-Tag
  (`data-betreiber="ja"`), statt in der gemeinsamen Datei verdrahtet zu sein.
  So ist je Seite sichtbar, was gilt.
- Die Service Worker dieses Repositories hatten dieselben Mängel wie die in
  `wasserentnahme-foehr`: Die Stellendaten lagen im dauerhaften
  Zwischenspeicher und der Zugangsschutz fehlte in der Dateiliste. Beides
  korrigiert, Zwischenspeicherversionen erhöht.

Neuer Test `test/browser/interne-seiten.test.js` prüft jede Seite einzeln:
Datenpflege und `nutzer-admin/` sind ohne Anmeldung und für angemeldete
Kunden ohne Betreiberrecht gesperrt, für Betreiberkonten frei; die
Nutzerversion verlangt ein Abo, aber kein Betreiberrecht; Kündigung,
Widerruf, AGB, Impressum und Registrierung bleiben ohne Anmeldung
erreichbar.

**Lehre daraus:** Ich hatte die Seiten in Repository 3 geprüft und
angenommen, die Kopie hier sei gleich aufgebaut. Der vollständige
Seitendurchlauf, der den Fehler zeigte, steht jetzt als Test im Repository.

## 3. Zwei Befunde, die eine Entscheidung des Betriebs brauchen

### 3.1 Die Repositories sind öffentlich

Alle drei Repositories sind öffentlich zugänglich. Damit ist
`daten/stellen.geojson` – der bezahlte Datenbestand – frei von GitHub
herunterladbar, unabhängig von jeder Prüfung in der Anwendung.

**Solange das so bleibt, ist der Zugriffsschutz eine Bequemlichkeitshürde und
kein wirtschaftlicher Schutz.** Das ist keine Schwäche der Umsetzung, sondern
eine Folge der Veröffentlichungsform.

Vorbereitet ist der Ausweg: Der Worker hat den Endpunkt `/api/stellen`, der die
Daten erst nach serverseitiger Berechtigungsprüfung ausliefert. Die Anwendung
nutzt ihn bereits und fällt nur deshalb noch auf die öffentliche Datei zurück,
weil die Quelle noch nicht konfiguriert ist.

Damit der Schutz wirkt, sind drei Schritte nötig:

1. `wasserentnahme-foehr` auf privat stellen,
2. `daten/stellen.geojson` an einen nicht öffentlichen Ort legen und
   `STELLEN_QUELLE_URL` im Worker setzen,
3. die Datei aus dem veröffentlichten Verzeichnis entfernen.

Alternative: bewusst entscheiden, dass die Kartendaten öffentlich sein dürfen,
und das Entgelt auf Bedienung, Aktualisierung und Offlinefähigkeit stützen.
Dann ist der Zugriffsschutz nur noch Vertragsdurchsetzung und die Beschreibung
des Angebots sollte das widerspiegeln.

### 3.2 Der Betrieb kann sich aussperren

Die internen Bereiche (Datenpflege unter der Wurzeladresse, `nutzer-admin/`)
verlangen jetzt ein vom Server bestätigtes Betreiberkonto. Die Liste steht in
der Worker-Variablen `BETREIBER_AUTH_EMAILS`.

**Diese Variable muss gesetzt sein, bevor die geschützten Seiten
veröffentlicht werden** – sonst ist die eigene Datenpflege nicht mehr
erreichbar. Einen Umgehungsweg gibt es bewusst nicht.

## 4. Geänderte Dateien

### loeschmeier-abo (Branch `claude/integration-loeschbaert`)

```
app/zugriffspruefung.js            serverseitiger Schutz statt Gnadenfrist im Browser
app/config.js                      Zugangsdaten fuer die Pruefung
app/nutzer/index.html              Ladereihenfolge der Skripte
app/nutzer-admin/index.html        dito
app/agb.html                       Darstellung auf schmalen Bildschirmen
app/datenschutz.html               dito
app/impressum.html                 dito
app/kuendigen.html                 Zusammenfassungsschritt, Zeitpunktwahl, Barrierefreiheit
app/kundenbereich.html             Absicherung gegen Ausfall der Anmeldebibliothek
app/rechnung.html                  dito
app/registrieren.html              Bestellübersicht, Bestellbutton, Ablaufsteuerung
app/widerruf.html                  Zusammenfassungsschritt, Barrierefreiheit
db/migration_sales_platform.sql    Tarif-Slugs auf Löschbärt
worker/src/index.js                CORS, Eingabeprüfung, Betreiberkennung, /api/stellen,
                                   Reihenfolge der Erklärungsverarbeitung, Gerätelimit
worker/src/legal.js                Vertragsnummer LB-
worker/wrangler.toml               neue Variablen
worker/dist/bundle.js              neu erzeugt
worker/test/legal.test.js          angepasst
worker/test/negativfaelle.test.js  neu: 23 Negativfälle
test/browser/*.test.js             neu: Bestellablauf und Erklärungsformulare
```

### roewise.com (Branch `claude/integration-loeschbaert`)

```
index.html      Gesamtpreis mit § 19 UStG, AGB verlinkt, Fokusmarkierung
einzelabo.html  Titel und Überschrift Löschbärt, Gesamtpreisangabe, Offline-Aussage
                präzisiert, Arbeitshilfe-Hinweis, AGB verlinkt
```

### wasserentnahme-foehr (Branch `claude/integration-loeschbaert`)

```
zugangsschutz.js           neu: gemeinsamer Zugangsschutz
index.html                 Betreiberprüfung, Datenabruf über geschützten Endpunkt
nutzer/index.html          gemeinsamer Zugangsschutz statt eigener Logik
nutzer-admin/index.html    Betreiberprüfung
sw.js, nutzer/sw.js,       Stellendaten nicht mehr im dauerhaften Zwischenspeicher,
nutzer-admin/sw.js         Zwischenspeicherversionen erhöht
config.js                  Bestellseite, erläuternde Hinweise
test-oldsum.html           entfernt (siehe unten)
test/zugangsschutz.test.js neu
```

`test-oldsum.html` war von keiner Seite verlinkt, lieferte die Stellendaten
ohne jede Prüfung aus und trug noch die alte Beschriftung „Testversion
Oldsum". Die Datei ist im Verlauf und auf `main` weiterhin vorhanden und kann
zurückgeholt werden, falls sie noch gebraucht wird.

## 5. Datenbankmigrationen

`db/migration_sales_platform.sql` (aus dem Codex-Branch, von mir nur bei den
Slugs geändert). Sie arbeitet durchgehend mit `add column if not exists` und
`create table if not exists`, legt keine Daten an außer dem Gemeinde-Platzhalter
und löscht nichts. Der einzige verändernde Schritt ist das Umstellen des alten
Monatstarifs (`code = 'monat'`) auf den Jahreszugang; dabei wird
`paypal_plan_id` bewusst auf `null` gesetzt, damit nicht versehentlich der
alte Monatsplan weiterverkauft wird.

Enthalten sind: Vertragsnummer, Leistungsbeginn, Mindestlaufzeit,
Kündigungswirksamkeit, Dokumentenversionen, Erstattungsfelder, die Tabellen
`legal_declarations`, `legal_acceptances`, `outbound_messages` sowie die
Funktion `next_invoice_number()` mit eigener Jahressequenz und
Transaktionssperre.

**Noch nicht ausgeführt.** Sie gehört einmalig in den Supabase-SQL-Editor,
sinnvollerweise nach einer Sicherung.

Offen geblieben (bewusst, weil ohne Kenntnis des Echtbestands riskant):
Aufbewahrungs- und Löschstatus als eigene Felder. Die Kontolöschung ist
weiterhin nur als Ablauf beschrieben, nicht als Funktion umgesetzt.

## 6. Neue Variablen und Geheimnisse

Alle im Cloudflare-Dashboard des Worker zu setzen. **Nichts davon gehört ins
Repository.**

| Name | Art | Zweck |
|---|---|---|
| `BETREIBER_AUTH_EMAILS` | Variable | Konten für die internen Bereiche. Ohne Eintrag sperrt sich der Betrieb aus. |
| `OEFFENTLICHE_BASIS_URL` | Variable | Adresse in allen Bestätigungen; beim Domainwechsel nur hier ändern |
| `BETREIBER_EMAIL` | Variable | Empfänger der Benachrichtigung über Kündigungen und Widerrufe |
| `ERLAUBTE_URSPRUENGE` | Variable | zusätzliche Domains für CORS |
| `STELLEN_QUELLE_URL` | Variable | Quelle für `/api/stellen`; erst setzen, wenn die Daten nicht mehr öffentlich liegen |
| `STELLEN_QUELLE_TOKEN` | Geheimnis | nur falls die Quelle eines braucht |
| `ADMIN_PASSWORT` | Geheimnis | Admin-Bereich |
| `RESEND_API_KEY` | Geheimnis | E-Mail-Versand |
| `SUPABASE_SERVICE_ROLE_KEY`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID` | Geheimnisse | wie bisher |

Geprüft: In keinem der drei Repositories und in keinem Branch steht ein
`service_role`-Schlüssel, ein PayPal-Geheimnis oder ein Resend-Schlüssel.
Öffentlich sind nur der Supabase-anon-Schlüssel und die PayPal-Client-ID –
beide sind für den Browser vorgesehen.

## 7. Testergebnisse

Alle Tests wurden ausgeführt. Es wurden **keine echten Zahlungen ausgelöst und
keine E-Mails an echte Empfänger versandt**; PayPal, Supabase und Resend sind
in den Tests nachgebildet.

### Worker: 30 von 30 bestanden (`cd worker && npm test`)

Rechenlogik: E-Mail-Prüfung, Textbegrenzung, anteilige Erstattung,
Vertragsnummer, Bestätigungstext, Pflichtfelder, ungültiges Wunschdatum.

Negativfälle:

| Fall | Ergebnis |
|---|---|
| fremder Ursprung ruft die API auf | keine CORS-Freigabe |
| fremde PayPal-Subscription (`custom_id` eines anderen Kontos) | abgelehnt |
| manipulierte Plan-ID | abgelehnt |
| Bestellung ohne Zustimmung | abgelehnt |
| zweite Bestellung desselben Kontos | abgelehnt, überzähliges PayPal-Abo sofort storniert |
| Bestellung bei `SALES_ENABLED=false` | abgelehnt |
| Webhook mit ungültiger Signatur | ändert nichts |
| **doppelter Webhook** | keine zweite Zahlung, keine zweite Rechnung |
| Webhook mit falschem Betrag | nicht gebucht, Fehlerstatus für Wiederzustellung |
| Webhook mit internem Fehler | Fehlerstatus, später erneut verarbeitbar |
| abgelaufener bezahlter Zeitraum | gesperrt |
| gekündigtes Abo ohne Enddatum | gesperrt |
| drittes Gerät | abgewiesen, bekanntes Gerät weiter frei |
| Gerätekennung mit Filterzeichen | abgewiesen |
| Betreiberkonto | frei, nur für die hinterlegte Adresse |
| **Kündigung bei PayPal-Ausfall** | Eingang gespeichert und bestätigt, Status „PayPal-Prüfung nötig" |
| Kündigung für unbekannten Vertrag | angenommen, zur manuellen Prüfung |
| **Widerruf bei gescheiterter Erstattung** | Eingang gespeichert, Vertrag beendet, Zahlung **nicht** fälschlich als erstattet markiert |
| **E-Mail-Ausfall** | Bestätigung erscheint sofort, Nachricht bleibt mit Fehlertext zum erneuten Senden vorgemerkt |
| unvollständige Erklärung | abgelehnt, nichts gespeichert |
| Admin ohne Passwort / mit unsinniger Kennung | abgewiesen |
| fremde Gerätekennung entfernen | abgewiesen, Gerät bleibt |
| Katalog ohne Verkaufsfreigabe | keine PayPal-Daten herausgegeben |

### Browser: Bestellablauf und Erklärungen

Bestellseite (angemeldet, mit nachgebildetem PayPal):
Bestellübersicht nennt alle zehn geprüften Pflichtangaben; kein Feld ist
vorangekreuzt; ohne Zustimmung und ohne Wahl des Leistungsbeginns erscheint
kein Zahlschritt; erst nach der Bestellung wird der PayPal-Button erzeugt;
übergeben werden die richtige Plan-ID und die Kontobindung; ohne sofortigen
Beginn liegt der Leistungsbeginn 14 Tage in der Zukunft, mit sofortigem Beginn
gibt es keine Verzögerung.

Kündigung und Widerruf: ohne Anmeldung erreichbar, Zusammenfassung erscheint
vor dem Absenden, Schaltflächen heißen „Jetzt kündigen" beziehungsweise
„Widerruf bestätigen", das Wunschdatum ist gesperrt solange „frühestmöglich"
gilt, „Angaben ändern" führt zurück.

### Browser: Zugriffsschutz der Anwendung

| Fall | Ergebnis |
|---|---|
| ohne Anmeldung | gesperrt |
| abgelaufenes Abo | gesperrt |
| Gerätelimit erreicht | gesperrt, mit Hinweis auf den Kundenbereich |
| aktives Abo | frei; 200 Listeneinträge, 784 Marker, PMTiles-Grundkarte gezeichnet |
| `?freigabe=1`, `?zugang=…`, `?test=1` | wirkungslos |
| manipuliertes `localStorage` (alte Testphasen-Schlüssel) | wirkungslos |
| Testkopie unter `test.roewise.com/nutzer/` mit gesetzter Gnadenfrist | wirkungslos (siehe 2.1) |
| Kunde ruft `nutzer-admin/` oder die Datenpflege auf | gesperrt |
| Betreiberkonto ruft die Datenpflege auf | frei |

### Darstellung

Alle öffentlichen Seiten bei 360 und 1280 Pixeln ohne Querscrollen und ohne
Skriptfehler. Farbkontraste erfüllen Stufe AA, der geringste gemessene Wert
liegt bei 6,7:1. Verweise: alle internen Ziele der drei Projekte lösen auf,
auch über Projektgrenzen hinweg (`test.roewise.com`, `foehr.roewise.com`).

### Nicht getestet

- Echter Durchlauf gegen die PayPal-Sandbox (erfordert Deployment und
  Zugangsdaten, beides bewusst nicht ausgeführt).
- Tatsächlicher E-Mail-Versand über Resend.
- Ausführung der Datenbankmigration auf dem Echtbestand.
- Reale Geräte: iPhone/Safari, Android, Edge. Geprüft wurde Chromium in zwei
  Breiten. Eine Grundprüfung mit Vorleseprogramm steht ebenfalls aus.

## 8. Offene Betreiberangaben

| Angabe | Stand |
|---|---|
| Gewerbeanmeldung | unbekannt |
| steuerliche Erfassung und Steuernummer | unbekannt |
| Umsatzsteuer-ID | unbekannt, vermutlich nicht vorhanden |
| Kleinunternehmerregelung § 19 UStG | **vom Betrieb als anzuwendend angegeben**; in AGB, Verkaufsseite und Bestellübersicht so dargestellt. Steuerlich bestätigen lassen. |
| Beschäftigtenzahl, Jahresumsatz, Bilanzsumme | unbekannt – nötig für die Frage, ob die Kleinstunternehmensausnahme des BFSG greift |
| Teilnahme an Verbraucherschlichtung | in den AGB mit „nimmt nicht teil" angegeben; prüfen, ob § 36 VSBG überhaupt greift |
| Telefonnummer im Impressum | vorhanden |

Es wurde **keine** dieser Angaben erfunden. Wo etwas fehlt, steht nichts.

## 9. Verbleibende Risiken

1. **Wirtschaftlicher Schutz** der Kartendaten fehlt, solange die
   Repositories öffentlich sind (Abschnitt 3.1).
2. **Kündigung und Widerruf ohne Anmeldung** setzen für die automatische
   Verarbeitung nur E-Mail-Adresse plus Vertragsnummer voraus. Wer beides
   kennt, kann einen fremden Vertrag beenden und eine Erstattung auslösen.
   Das ist die Kehrseite der gesetzlich geforderten Erreichbarkeit ohne Login.
   Begrenzt ist es durch die Bindung an genau dieses Kundenkonto und durch
   ein Limit von zehn Erklärungen je Stunde und Adresse. Ob die automatische
   Erstattung so bleiben soll oder erst nach Sichtung ausgelöst wird, ist eine
   Abwägung, die der Betrieb treffen sollte.
3. **Admin-Bereich** hängt weiter an einem einzigen Passwort ohne zweiten
   Faktor. Abgesichert durch Mengenbegrenzung, aber kein vollwertiges
   Berechtigungssystem.
4. **`@supabase/supabase-js@2`** wird weiterhin gleitend von jsDelivr geladen.
   Eine feste Version mit Integritätsprüfung wäre besser; der dafür nötige
   Prüfwert lässt sich nur aus der tatsächlich ausgelieferten Datei bilden,
   wozu in dieser Umgebung kein Netzzugang bestand. Vor dem Livegang nachholen
   oder die Bibliothek selbst ausliefern.
5. **Zeitzonen**: alle Fristen rechnen in UTC. Bei Monatswechseln kann das
   Vertragsende einen Tag abweichen von dem, was jemand lokal erwartet.
6. **Wertersatz bei Widerruf** nach vorzeitigem Leistungsbeginn ist in den
   Texten erwähnt, wird aber nicht berechnet; eine Erstattung erfolgt in voller
   Höhe. Kaufmännisch harmlos bei 12 Euro, juristisch zu bestätigen.
7. **Kontolöschung** ist beschrieben, aber nicht als Funktion vorhanden.
8. **Testdomain**: Der Verkauf verweist auf `test.roewise.com`. Für einen
   echten Verkaufsstart wirkt das unstimmig; die endgültige Adresse gehört in
   `OEFFENTLICHE_BASIS_URL` und in die Verweise der Verkaufsseite.

## 10. Schritte vor einer Live-Schaltung

Technisch:

1. `BETREIBER_AUTH_EMAILS` setzen (sonst Aussperrung), dann erst
   veröffentlichen.
2. Migration in Supabase ausführen, vorher sichern.
3. Worker-Bundle aus `worker/dist/bundle.js` einspielen, Variablen und
   Geheimnisse setzen.
4. Zeilenschutz (RLS) der neuen Tabellen im Echtbetrieb stichprobenhaft
   nachprüfen.
5. Vollständigen Durchlauf in der PayPal-Sandbox: Bestellung, Zahlungseingang,
   Rechnung, E-Mail, Zugriff, Kündigung, anteilige Erstattung, Widerruf,
   doppelter Webhook.
6. E-Mail-Versand real testen, einschließlich der Warteschlange nach einem
   erzwungenen Fehler.
7. Entscheidung zu Abschnitt 3.1 umsetzen.
8. Supabase-Bibliothek festnageln oder selbst ausliefern.
9. Domain festlegen und überall eintragen.
10. Auf einem iPhone, einem Android-Gerät und mit Tastatur allein bedienen.

Kaufmännisch und rechtlich:

11. Gewerbe- und Steuerfragen klären; § 19 UStG bestätigen lassen.
12. AGB, Widerrufsbelehrung, Datenschutzerklärung und Impressum anwaltlich
    prüfen lassen, ebenso die Gestaltung des Bestellablaufs.
13. Auftragsverarbeitungsverträge mit Supabase, Cloudflare, Resend und PayPal
    prüfen und ablegen.
14. BFSG-Betroffenheit anhand der tatsächlichen Unternehmenskennzahlen klären.
15. Erst danach `SALES_ENABLED` auf `true`.

## 11. Freigabe für den Live-Verkauf

**Nein.** Der Stand ist ein belastbarer Teststand, kein verkaufsfertiges
System. `SALES_ENABLED` steht auf `false`, es wurde nichts veröffentlicht,
nichts gemerged und keine Zahlung ausgelöst.

Die technischen Hindernisse sind benannt und abarbeitbar. Die verbleibenden
Hindernisse sind keine technischen: die offenen Betreiberangaben aus
Abschnitt 8, die Entscheidung aus Abschnitt 3.1 und die externe rechtliche und
steuerliche Prüfung.

## 12. Nachtrag 22.9.2026: Kündigungsregel geändert

Auf ausdrücklichen Wunsch des Betreibers geändert von „nach 12 Monaten
Mindestlaufzeit jederzeit kündbar, anteilige Erstattung" auf:

- 12 Monate Mindestlaufzeit, danach automatische Verlängerung um jeweils
  weitere 12 Monate
- ordentlich kündbar mit einer Frist von 6 Wochen zum Ende der jeweiligen
  Laufzeit; wird diese Frist unterschritten, verlängert sich der Vertrag um
  ein weiteres Jahr
- für die ordentliche Kündigung entfällt die anteilige Erstattung (sie wirkt
  ja nur noch zum ohnehin bezahlten Laufzeitende)
- außerordentliche Kündigung aus wichtigem Grund und das gesetzliche
  14-Tage-Widerrufsrecht bleiben unverändert bestehen (weiterhin sofort
  wirksam, mit anteiliger Erstattung/Wertersatz nach den gesetzlichen Regeln)

Geändert: AGB (`app/agb.html`), Bestellübersicht und Kündigungsformular
(`app/registrieren.html`, `app/kuendigen.html`), Kundenbereich-Dialogtext
(`app/kundenbereich.html`), Worker-Logik `kuendigungVerarbeiten`
(`worker/src/index.js`, Bundle neu gebaut), PayPal-Plan-Beschreibungstext
(`setup/paypal_plan_erstellen.py`) sowie die Marketingtexte in
`roewise.com` (`index.html`, `einzelabo.html`).

**Wichtig:** Der bereits im PayPal-Sandbox angelegte Plan
(`P-0PT23151YG359235SNKYWEQI`) trägt weiterhin die alte Beschreibung –
PayPal aktualisiert den Text eines bestehenden Plans nicht automatisch durch
eine Änderung des Erstellungsskripts. Für die Sandbox-Tests ist das
unschädlich (`SALES_ENABLED=false`), vor einer Live-Schaltung mit diesem
neuen Vertragsmodell sollte der Plan-Text im PayPal-Dashboard geprüft und
bei Bedarf ein neuer Plan mit korrektem Text angelegt werden.

Drei neue Worker-Tests decken die neue Regel ab (mehr als 6 Wochen Vorlauf,
weniger als 6 Wochen Vorlauf, außerordentliche Kündigung), 33 von 33
Worker-Tests bestehen. Ein Groß-/Kleinschreibungsfehler in einem
Browser-Test (`test/browser/erklaerungen.test.js`) wurde dabei gefunden und
behoben – er bestand bereits vor dieser Änderung und war nicht durch die
Kündigungsregel verursacht.
