/* Negativfaelle des Worker.

   Der Worker wird mit nachgebildeten Antworten von Supabase, PayPal und
   Resend betrieben. Dadurch lassen sich Faelle pruefen, die sich mit echten
   Diensten nicht oder nur schwer ausloesen lassen - doppelte Webhooks,
   manipulierte Abo-Kennungen, ein Ausfall der Zahlungsschnittstelle oder ein
   fehlgeschlagener E-Mail-Versand. Es werden dabei keine echten Zahlungen
   ausgeloest und keine echten E-Mails versandt. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
const QUELLE = join(HIER, "..", "src");

// Der Worker wird als Text geladen und in einer eigenen Umgebung ausgewertet,
// damit fetch, crypto und console ersetzt werden koennen.
async function ladeWorker(umgebung) {
  const dateien = ["supabase.js", "paypal.js", "legal.js", "index.js"];
  let quelltext = "";
  for (const datei of dateien) {
    let inhalt = readFileSync(join(QUELLE, datei), "utf8");
    inhalt = inhalt.replace(/^import\s+[^;]+;\s*$/gm, "");
    inhalt = inhalt.replace(/^import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*$/gm, "");
    inhalt = inhalt.replace(/^export\s+default\s+/m, "globalThis.__worker = ");
    inhalt = inhalt.replace(/^export\s+/gm, "");
    quelltext += inhalt + "\n";
  }
  const modul = new Function("globalThis", "fetch", "console", "crypto", quelltext + "\nreturn globalThis.__worker;");
  return modul(umgebung.globalThis, umgebung.fetch, umgebung.console, umgebung.crypto);
}

// Minimaler Ersatz fuer Supabase (PostgREST), PayPal und Resend.
function baueUmgebung({ tabellen = {}, paypal = {}, emailFehler = false } = {}) {
  const protokoll = { paypalAufrufe: [], emails: [], eingefuegt: {}, aktualisiert: {} };
  const daten = JSON.parse(JSON.stringify(tabellen));

  function tabelle(name) {
    if (!daten[name]) daten[name] = [];
    return daten[name];
  }

  function passtZuFilter(zeile, abfrage) {
    for (const teil of abfrage.split("&")) {
      const [feld, bedingung] = teil.split("=");
      if (!bedingung || ["select", "order", "limit"].includes(feld)) continue;
      const [operator, ...rest] = bedingung.split(".");
      const wert = decodeURIComponent(rest.join("."));
      if (operator === "eq" && String(zeile[feld]) !== wert) return false;
      if (operator === "in") {
        const erlaubt = wert.replace(/[()]/g, "").split(",");
        if (!erlaubt.includes(String(zeile[feld]))) return false;
      }
      if (operator === "is") {
        const sollNull = wert === "null";
        const istNull = zeile[feld] === null || zeile[feld] === undefined;
        if (sollNull !== istNull) return false;
      }
    }
    return true;
  }

  const fetchErsatz = async (url, optionen = {}) => {
    const adresse = String(url);
    const methode = (optionen.method || "GET").toUpperCase();

    if (adresse.includes("/rest/v1/")) {
      const [pfad, abfrage = ""] = adresse.split("/rest/v1/")[1].split("?");
      if (pfad.startsWith("rpc/")) {
        return new Response(JSON.stringify("2026-0001"), { status: 200 });
      }
      const zeilen = tabelle(pfad);
      if (methode === "GET") {
        return new Response(JSON.stringify(zeilen.filter((z) => passtZuFilter(z, abfrage))), { status: 200 });
      }
      if (methode === "POST") {
        const neu = JSON.parse(optionen.body).map((eintrag, i) => ({
          id: eintrag.id || `${pfad}-${zeilen.length + i + 1}`,
          ...eintrag,
        }));
        zeilen.push(...neu);
        protokoll.eingefuegt[pfad] = (protokoll.eingefuegt[pfad] || 0) + neu.length;
        return new Response(JSON.stringify(neu), { status: 201 });
      }
      if (methode === "PATCH") {
        const patch = JSON.parse(optionen.body);
        const betroffen = zeilen.filter((z) => passtZuFilter(z, abfrage));
        betroffen.forEach((z) => Object.assign(z, patch));
        protokoll.aktualisiert[pfad] = (protokoll.aktualisiert[pfad] || 0) + betroffen.length;
        return new Response(JSON.stringify(betroffen), { status: 200 });
      }
      if (methode === "DELETE") {
        daten[pfad] = zeilen.filter((z) => !passtZuFilter(z, abfrage));
        return new Response("[]", { status: 200 });
      }
    }

    if (adresse.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "test" }), { status: 200 });
    }
    if (adresse.includes("/v1/notifications/verify-webhook-signature")) {
      return new Response(
        JSON.stringify({ verification_status: paypal.signaturGueltig === false ? "FAILURE" : "SUCCESS" }),
        { status: 200 }
      );
    }
    if (adresse.includes("/v1/billing/subscriptions/")) {
      protokoll.paypalAufrufe.push(adresse);
      if (adresse.endsWith("/cancel")) {
        return new Response(null, { status: paypal.kuendigungFehler ? 500 : 204 });
      }
      return new Response(JSON.stringify(paypal.abo || {}), { status: paypal.aboFehler ? 404 : 200 });
    }
    if (adresse.includes("/v1/payments/sale/")) {
      protokoll.paypalAufrufe.push(adresse);
      if (paypal.erstattungFehler) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ id: "REF-1" }), { status: 200 });
    }
    if (adresse.includes("api.resend.com")) {
      if (emailFehler) return new Response("{}", { status: 500 });
      protokoll.emails.push(JSON.parse(optionen.body));
      return new Response(JSON.stringify({ id: "mail-1" }), { status: 200 });
    }
    if (adresse.includes("/auth/v1/user")) {
      const token = (optionen.headers?.Authorization || "").replace("Bearer ", "");
      if (token === "gueltig") {
        return new Response(JSON.stringify({ id: "user-1", email: "kunde@example.test" }), { status: 200 });
      }
      if (token === "betrieb") {
        return new Response(JSON.stringify({ id: "user-9", email: "betrieb@example.test" }), { status: 200 });
      }
      return new Response("{}", { status: 401 });
    }
    throw new Error("Unerwarteter Aufruf: " + adresse);
  };

  return {
    protokoll,
    daten,
    umgebung: {
      globalThis: { Response, Headers, Request, URL, JSON, Date, Math, Promise, Number, String, Boolean, Object, Array, Set, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent },
      fetch: fetchErsatz,
      console: { error() {}, warn() {}, log() {} },
      crypto: { randomUUID: () => "12345678-1234-4123-8123-123456789012" },
    },
  };
}

const ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_ANON_KEY: "anon",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_SECRET: "secret",
  PAYPAL_WEBHOOK_ID: "webhook",
  SALES_ENABLED: "true",
  RESEND_API_KEY: "resend",
  TRANSACTIONAL_FROM: "test@example.test",
  BETREIBER_AUTH_EMAILS: "betrieb@example.test",
};

function anfrage(pfad, { methode = "GET", koerper = null, token = null, ursprung = null } = {}) {
  const kopf = { "Content-Type": "application/json" };
  if (token) kopf.Authorization = "Bearer " + token;
  if (ursprung) kopf.Origin = ursprung;
  return new Request("https://worker.test" + pfad, {
    method: methode,
    headers: kopf,
    body: koerper ? JSON.stringify(koerper) : undefined,
  });
}

const TARIF = {
  id: "tarif-1", code: "foehr-jahr", bezeichnung: "Löschbärt Föhr – Jahreszugang",
  preis_cent: 1200, waehrung: "EUR", aktiv: true, oeffentlich: true,
  paypal_plan_id: "P-ECHT", max_geraete: 2,
};

test("CORS: fremder Ursprung erhaelt keine Freigabe", async () => {
  const { umgebung } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const fremd = await worker.fetch(anfrage("/api/katalog", { ursprung: "https://boese.example" }), ENV);
  assert.equal(fremd.headers.get("Access-Control-Allow-Origin"), null);

  const eigen = await worker.fetch(anfrage("/api/katalog", { ursprung: "https://test.roewise.com" }), ENV);
  assert.equal(eigen.headers.get("Access-Control-Allow-Origin"), "https://test.roewise.com");
});

test("Abo anlegen: fremde Subscription wird abgelehnt", async () => {
  const { umgebung } = baueUmgebung({
    tabellen: { tariffs: [TARIF], customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }] },
    // custom_id zeigt auf ein anderes Konto
    paypal: { abo: { status: "APPROVED", plan_id: "P-ECHT", custom_id: "user-FREMD" } },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/abo-anlegen", {
      methode: "POST", token: "gueltig",
      koerper: { paypal_subscription_id: "I-ABC", tariff_code: "foehr-jahr", agb_akzeptiert: true, sofortiger_beginn: true },
    }), ENV);
  assert.equal(antwort.status, 400);
  assert.equal((await antwort.json()).fehler, "paypal_abo_gehoert_nicht_zum_konto");
});

test("Abo anlegen: manipulierte Plan-ID wird abgelehnt", async () => {
  const { umgebung } = baueUmgebung({
    tabellen: { tariffs: [TARIF], customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }] },
    paypal: { abo: { status: "APPROVED", plan_id: "P-BILLIG", custom_id: "user-1" } },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/abo-anlegen", {
      methode: "POST", token: "gueltig",
      koerper: { paypal_subscription_id: "I-ABC", tariff_code: "foehr-jahr", agb_akzeptiert: true, sofortiger_beginn: true },
    }), ENV);
  assert.equal(antwort.status, 400);
  assert.equal((await antwort.json()).fehler, "paypal_abo_ungueltig");
});

test("Abo anlegen: ohne Zustimmung keine Anlage", async () => {
  const { umgebung } = baueUmgebung({ tabellen: { tariffs: [TARIF] } });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/abo-anlegen", {
      methode: "POST", token: "gueltig",
      koerper: { paypal_subscription_id: "I-ABC", tariff_code: "foehr-jahr", agb_akzeptiert: false, sofortiger_beginn: true },
    }), ENV);
  assert.equal(antwort.status, 400);
});

test("Abo anlegen: zweite Bestellung desselben Kontos wird verhindert", async () => {
  const { umgebung, protokoll } = baueUmgebung({
    tabellen: {
      tariffs: [TARIF],
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }],
      subscriptions: [{ id: "abo-1", customer_id: "kunde-1", status: "aktiv", paypal_subscription_id: "I-ALT" }],
    },
    paypal: { abo: { status: "APPROVED", plan_id: "P-ECHT", custom_id: "user-1" } },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/abo-anlegen", {
      methode: "POST", token: "gueltig",
      koerper: { paypal_subscription_id: "I-NEU", tariff_code: "foehr-jahr", agb_akzeptiert: true, sofortiger_beginn: true },
    }), ENV);
  assert.equal(antwort.status, 409);
  // Das ueberzaehlige PayPal-Abo wird sofort wieder storniert.
  assert.ok(protokoll.paypalAufrufe.some((a) => a.includes("I-NEU/cancel")));
});

test("Verkaufssperre: ohne SALES_ENABLED keine Bestellung", async () => {
  const { umgebung } = baueUmgebung({ tabellen: { tariffs: [TARIF] } });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/abo-anlegen", {
      methode: "POST", token: "gueltig",
      koerper: { paypal_subscription_id: "I-ABC", tariff_code: "foehr-jahr", agb_akzeptiert: true, sofortiger_beginn: true },
    }), { ...ENV, SALES_ENABLED: "false" });
  assert.equal(antwort.status, 503);
});

test("Webhook: ungueltige Signatur aendert nichts", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: { subscriptions: [{ id: "abo-1", paypal_subscription_id: "I-ABC", status: "wird_geprueft" }] },
    paypal: { signaturGueltig: false },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/webhook/paypal", {
      methode: "POST",
      koerper: { id: "EV-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-ABC" } },
    }), ENV);
  assert.equal(antwort.status, 400);
  assert.equal(daten.subscriptions[0].status, "wird_geprueft");
});

test("Webhook: doppelte Zustellung erzeugt keine zweite Zahlung und keine zweite Rechnung", async () => {
  const basis = {
    tabellen: {
      subscriptions: [{ id: "abo-1", paypal_subscription_id: "I-ABC", status: "aktiv", tariffs: { preis_cent: 1200, waehrung: "EUR" }, sofortiger_beginn: true }],
      tariffs: [TARIF],
    },
    paypal: { abo: { status: "ACTIVE", billing_info: { next_billing_time: "2027-09-21T00:00:00Z" } } },
  };
  const { umgebung, daten } = baueUmgebung(basis);
  const worker = await ladeWorker(umgebung);
  const ereignis = {
    id: "EV-2", event_type: "PAYMENT.SALE.COMPLETED",
    resource: { id: "SALE-1", billing_agreement_id: "I-ABC", amount: { total: "12.00", currency: "EUR" } },
  };
  const ersteAntwort = await worker.fetch(anfrage("/webhook/paypal", { methode: "POST", koerper: ereignis }), ENV);
  assert.equal(ersteAntwort.status, 200);
  assert.equal(daten.payments.length, 1);
  assert.equal(daten.invoices.length, 1);

  const zweiteAntwort = await worker.fetch(anfrage("/webhook/paypal", { methode: "POST", koerper: ereignis }), ENV);
  assert.equal(zweiteAntwort.status, 200);
  assert.equal(daten.payments.length, 1, "keine doppelte Zahlung");
  assert.equal(daten.invoices.length, 1, "keine doppelte Rechnung");
});

test("Webhook: falscher Betrag wird nicht gebucht und fuehrt zur Wiederzustellung", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      subscriptions: [{ id: "abo-1", paypal_subscription_id: "I-ABC", status: "aktiv", tariffs: { preis_cent: 1200, waehrung: "EUR" }, sofortiger_beginn: true }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/webhook/paypal", {
      methode: "POST",
      koerper: {
        id: "EV-3", event_type: "PAYMENT.SALE.COMPLETED",
        resource: { id: "SALE-X", billing_agreement_id: "I-ABC", amount: { total: "1.00", currency: "EUR" } },
      },
    }), ENV);
  // Fehlerstatus, damit PayPal erneut zustellt; nichts wurde gebucht.
  assert.equal(antwort.status, 500);
  assert.equal((daten.payments || []).length, 0);
});

test("Webhook: interner Fehler meldet Fehlerstatus und erlaubt spaeteren zweiten Versuch", async () => {
  const { umgebung, daten } = baueUmgebung({ tabellen: { subscriptions: [] } });
  const worker = await ladeWorker(umgebung);
  const ereignis = {
    id: "EV-4", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-UNBEKANNT" },
  };
  const erste = await worker.fetch(anfrage("/webhook/paypal", { methode: "POST", koerper: ereignis }), ENV);
  assert.equal(erste.status, 500);
  assert.equal(daten.webhook_events[0].ergebnis, "fehler");

  // Sobald das Abo existiert, darf dasselbe Ereignis erneut verarbeitet werden.
  daten.subscriptions.push({ id: "abo-1", paypal_subscription_id: "I-UNBEKANNT", sofortiger_beginn: true });
  const zweite = await worker.fetch(anfrage("/webhook/paypal", { methode: "POST", koerper: ereignis }), ENV);
  assert.equal(zweite.status, 200);
  assert.equal(daten.subscriptions[0].status, "aktiv");
});

test("Zugriff: abgelaufener bezahlter Zeitraum sperrt", async () => {
  const { umgebung } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }],
      subscriptions: [{ id: "abo-1", customer_id: "kunde-1", status: "aktiv", bezahlt_bis: "2020-01-01T00:00:00Z" }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/zugriff?geraet=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { token: "gueltig" }), ENV);
  assert.equal((await antwort.json()).grund, "bezahlter_zeitraum_beendet");
});

test("Zugriff: gekuendigtes Abo ohne Enddatum gibt nichts frei", async () => {
  const { umgebung } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }],
      subscriptions: [{ id: "abo-1", customer_id: "kunde-1", status: "gekuendigt_zum_ende", bezahlt_bis: null }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/zugriff?geraet=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { token: "gueltig" }), ENV);
  const ergebnis = await antwort.json();
  assert.equal(ergebnis.erlaubt, false);
  assert.equal(ergebnis.grund, "vertragsende_ungeklaert");
});

test("Zugriff: drittes Geraet wird abgewiesen, bekanntes Geraet nicht", async () => {
  const { umgebung } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }],
      subscriptions: [{ id: "abo-1", customer_id: "kunde-1", status: "aktiv", bezahlt_bis: "2099-01-01T00:00:00Z", tariffs: { max_geraete: 2 } }],
      devices: [
        { id: "g1", customer_id: "kunde-1", geraet_name: "11111111-1111-4111-8111-111111111111" },
        { id: "g2", customer_id: "kunde-1", geraet_name: "22222222-2222-4222-8222-222222222222" },
      ],
    },
  });
  const worker = await ladeWorker(umgebung);
  const drittes = await worker.fetch(
    anfrage("/api/zugriff?geraet=33333333-3333-4333-8333-333333333333", { token: "gueltig" }), ENV);
  assert.equal((await drittes.json()).grund, "geraetelimit_erreicht");

  const bekannt = await worker.fetch(
    anfrage("/api/zugriff?geraet=11111111-1111-4111-8111-111111111111", { token: "gueltig" }), ENV);
  assert.equal((await bekannt.json()).erlaubt, true);
});

test("Zugriff: ungueltige Geraetekennung wird abgewiesen", async () => {
  const { umgebung } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/zugriff?geraet=" + encodeURIComponent("*&customer_id=eq.fremd"), { token: "gueltig" }), ENV);
  assert.equal(antwort.status, 400);
  assert.equal((await antwort.json()).grund, "fehlende_angaben");
});

test("Zugriff: Betreiberkonto ist frei, aber nur fuer die hinterlegte Adresse", async () => {
  const { umgebung } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const betrieb = await worker.fetch(
    anfrage("/api/zugriff?geraet=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { token: "betrieb" }), ENV);
  const ergebnisBetrieb = await betrieb.json();
  assert.equal(ergebnisBetrieb.erlaubt, true);
  assert.equal(ergebnisBetrieb.betreiber, true);

  const kunde = await worker.fetch(
    anfrage("/api/zugriff?geraet=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { token: "gueltig" }), ENV);
  assert.notEqual((await kunde.json()).betreiber, true);
});

test("Kuendigung ohne Anmeldung: Eingang bleibt erhalten, auch wenn PayPal ausfaellt", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", bezahlt_bis: "2027-01-01T00:00:00Z",
        mindestlaufzeit_bis: "2027-01-01T00:00:00Z",
      }],
    },
    paypal: { kuendigungFehler: true },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ordentlich",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  const ergebnis = await antwort.json();
  assert.ok(ergebnis.vorgangsnummer, "Vorgangsnummer wird sofort vergeben");
  assert.ok(ergebnis.bestaetigung.includes("Eingangsbestätigung"));
  assert.equal(daten.legal_declarations.length, 1);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "paypal_pruefung_noetig");
});

test("Kuendigung ohne Anmeldung: unbekannter Vertrag wird trotzdem angenommen", async () => {
  const { umgebung, daten } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Unbekannt", email: "niemand@example.test",
        vertragsreferenz: "LB-9999-XXX", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ordentlich",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "manuelle_pruefung");
  assert.equal(daten.legal_declarations[0].zugeordnet, false);
});

test("Widerruf: Eingang bleibt erhalten, wenn die Erstattung scheitert", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{ id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC", paypal_subscription_id: "I-ABC" }],
      payments: [{ id: "zahl-1", subscription_id: "abo-1", status: "erfolgreich", paypal_capture_id: "SALE-1", betrag_cent: 1200 }],
    },
    paypal: { erstattungFehler: true },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/widerrufen", {
      methode: "POST",
      koerper: {
        name: "Max Mustermann", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "erstattung_manuell_pruefen");
  // Der Vertrag ist trotzdem beendet und die Zahlung nicht faelschlich als erstattet markiert.
  assert.equal(daten.subscriptions[0].status, "widerrufen");
  assert.equal(daten.payments[0].status, "erfolgreich");
});

test("Widerruf nach Ablauf der 14-Tage-Frist wird nicht automatisch erstattet", async () => {
  const vertragsschluss = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // vor 20 Tagen
  const { umgebung, daten, protokoll } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", erstellt_am: vertragsschluss.toISOString(),
      }],
      payments: [{ id: "zahl-1", subscription_id: "abo-1", status: "erfolgreich", paypal_capture_id: "SALE-1", betrag_cent: 1200 }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/widerrufen", {
      methode: "POST",
      koerper: {
        name: "Max Mustermann", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "widerrufsfrist_abgelaufen");
  // Nichts automatisch veraendert: kein Vertragsstatus-Wechsel, keine
  // Erstattung, kein PayPal-Aufruf zur Kuendigung.
  assert.equal(daten.subscriptions[0].status, "aktiv");
  assert.equal(daten.payments[0].status, "erfolgreich");
  assert.ok(!protokoll.paypalAufrufe.some((a) => a.includes("cancel")));
});

test("Widerruf innerhalb der 14-Tage-Frist wird weiterhin automatisch erstattet", async () => {
  const vertragsschluss = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // vor 5 Tagen
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", erstellt_am: vertragsschluss.toISOString(),
      }],
      payments: [{ id: "zahl-1", subscription_id: "abo-1", status: "erfolgreich", paypal_capture_id: "SALE-1", betrag_cent: 1200 }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/widerrufen", {
      methode: "POST",
      koerper: {
        name: "Max Mustermann", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "erstattet");
  assert.equal(daten.subscriptions[0].status, "erstattet");
  assert.equal(daten.payments[0].status, "erstattet");
});

test("E-Mail-Ausfall: Erklaerung gilt trotzdem und bleibt zum erneuten Senden vorgemerkt", async () => {
  const { umgebung, daten } = baueUmgebung({ emailFehler: true });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/widerrufen", {
      methode: "POST",
      koerper: {
        name: "Max Mustermann", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
      },
    }), ENV);
  assert.equal(antwort.status, 200, "die Bestaetigung erscheint trotzdem sofort");
  assert.equal(daten.legal_declarations.length, 1);
  assert.equal(daten.outbound_messages[0].status, "ausstehend");
  assert.ok(daten.outbound_messages[0].letzter_fehler, "der Fehler wird protokolliert");
});

test("Rechtserklaerung: unvollstaendige Angaben werden abgelehnt", async () => {
  const { umgebung, daten } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: { name: "", email: "keine-mail", vertragsreferenz: "", erklaerungsart: "ordentlich" },
    }), ENV);
  assert.equal(antwort.status, 400);
  assert.equal((daten.legal_declarations || []).length, 0);
});

test("Admin: ohne Passwort kein Zugang, mit falscher Kennung keine Datenbankabfrage", async () => {
  const { umgebung } = baueUmgebung();
  const worker = await ladeWorker(umgebung);
  const ohne = await worker.fetch(anfrage("/api/admin/uebersicht"), { ...ENV, ADMIN_PASSWORT: "geheim" });
  assert.equal(ohne.status, 401);

  const mitFalscherId = new Request("https://worker.test/api/admin/sperren", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Passwort": "geheim" },
    body: JSON.stringify({ subscription_id: "*" }),
  });
  const antwort = await worker.fetch(mitFalscherId, { ...ENV, ADMIN_PASSWORT: "geheim" });
  assert.equal(antwort.status, 400);
});

test("Geraet entfernen: fremde Kennung wird abgewiesen", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1" }],
      devices: [{ id: "99999999-9999-4999-8999-999999999999", customer_id: "kunde-FREMD", geraet_name: "x" }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/geraet-entfernen", {
      methode: "POST", token: "gueltig",
      koerper: { device_id: "99999999-9999-4999-8999-999999999999" },
    }), ENV);
  assert.equal(antwort.status, 404);
  assert.equal(daten.devices.length, 1, "fremdes Geraet bleibt bestehen");
});

test("Katalog gibt ohne Verkaufsfreigabe keine PayPal-Daten heraus", async () => {
  const { umgebung } = baueUmgebung({ tabellen: { tariffs: [TARIF] } });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(anfrage("/api/katalog"), { ...ENV, SALES_ENABLED: "false" });
  const katalog = await antwort.json();
  assert.equal(katalog.verkaufAktiv, false);
  assert.equal(katalog.paypalClientId, null);
  assert.equal(katalog.tarife[0].paypalPlanId, null);
  assert.equal(katalog.tarife[0].kaufbar, false);
});

// ---- Neue Kuendigungsregel: 12 Monate Mindestlaufzeit, danach Verlaengerung
// um je 12 Monate, ordentlich kuendbar mit 6 Wochen Frist zum Laufzeitende,
// ohne anteilige Erstattung. Ausserordentliche Kuendigung wirkt weiterhin
// sofort, mit anteiliger Erstattung der ungenutzten Restzeit.

test("Kuendigung auf bereits erstatteten Vertrag ueberschreibt den Status nicht", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "erstattet", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", bezahlt_bis: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
        kuendigungswirksam_am: "2026-09-22T16:51:09.678Z",
      }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ordentlich",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "vertrag_bereits_beendet");
  // Der schon erstattete Vertrag bleibt "erstattet" - wird NICHT auf
  // "gekuendigt_zum_ende" zurueckgesetzt.
  assert.equal(daten.subscriptions[0].status, "erstattet");
});

test("Widerruf auf bereits erstatteten Vertrag ueberschreibt den Status nicht", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "erstattet", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC",
        erstellt_am: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        kuendigungswirksam_am: "2026-09-22T16:51:09.678Z",
      }],
      payments: [{ id: "zahl-1", subscription_id: "abo-1", status: "erstattet", paypal_capture_id: "SALE-1", betrag_cent: 1200, erstattet_cent: 1200 }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/widerrufen", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "vertrag_bereits_beendet");
  // Bleibt "erstattet" - wird NICHT faelschlich auf "widerrufen" zurueckgesetzt.
  assert.equal(daten.subscriptions[0].status, "erstattet");
  assert.equal(daten.payments[0].status, "erstattet");
});

test("Ordentliche Kuendigung mit mehr als 6 Wochen Vorlauf wirkt zum Laufzeitende, ohne Erstattung", async () => {
  const paidUntil = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000); // weit in der Zukunft
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", bezahlt_bis: paidUntil.toISOString(),
        mindestlaufzeit_bis: paidUntil.toISOString(),
      }],
      payments: [{ id: "zahlung-1", subscription_id: "abo-1", status: "erfolgreich", paypal_capture_id: "C-1", betrag_cent: 1200, waehrung: "EUR", zeitpunkt: new Date().toISOString(), erstattet_cent: 0 }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ordentlich",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].wirksam_zum, paidUntil.toISOString());
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "zugeordnet");
  assert.equal(daten.payments[0].status, "erfolgreich", "keine Erstattung bei ordentlicher Kuendigung");
});

test("Ordentliche Kuendigung weniger als 6 Wochen vor Laufzeitende verlaengert den Vertrag um ein Jahr", async () => {
  const paidUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // in 10 Tagen, zu spaet fuer die 6-Wochen-Frist
  const erwartet = new Date(paidUntil);
  erwartet.setUTCFullYear(erwartet.getUTCFullYear() + 1);
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", bezahlt_bis: paidUntil.toISOString(),
        mindestlaufzeit_bis: paidUntil.toISOString(),
      }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ordentlich",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].wirksam_zum, erwartet.toISOString());
});

test("Ausserordentliche Kuendigung wirkt sofort und erstattet die ungenutzte Restzeit anteilig", async () => {
  const zahlungAm = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  const paidUntil = new Date(zahlungAm.getTime() + 365 * 24 * 60 * 60 * 1000);
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", auth_user_id: "user-1", email: "kunde@example.test" }],
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv", vertragsnummer: "LB-2026-ABC",
        paypal_subscription_id: "I-ABC", bezahlt_bis: paidUntil.toISOString(),
        mindestlaufzeit_bis: zahlungAm.toISOString(),
      }],
      payments: [{ id: "zahlung-1", subscription_id: "abo-1", status: "erfolgreich", paypal_capture_id: "C-1", betrag_cent: 1200, waehrung: "EUR", zeitpunkt: zahlungAm.toISOString(), erstattet_cent: 0 }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/kuendigung-erklaeren", {
      methode: "POST",
      koerper: {
        name: "Erika Musterfrau", email: "kunde@example.test",
        vertragsreferenz: "LB-2026-ABC", vertragsbezeichnung: "Löschbärt Föhr – Jahreszugang",
        erklaerungsart: "ausserordentlich", grund: "Dienst dauerhaft nicht erreichbar",
      },
    }), ENV);
  assert.equal(antwort.status, 200);
  assert.equal(daten.legal_declarations[0].verarbeitungsstatus, "anteilig_erstattet");
  assert.ok(daten.payments[0].erstattet_cent > 0, "anteilige Erstattung erfolgt bei ausserordentlicher Kuendigung");
  assert.notEqual(daten.legal_declarations[0].wirksam_zum, paidUntil.toISOString(), "wirkt sofort, nicht erst zum Laufzeitende");
});

// ---- Manuell angelegter Zugang (Zahlung ausserhalb PayPal, z.B. Feuerwehr/
// Gemeinde per Ueberweisung) ----

test("Admin: manueller Zugang wird angelegt, ohne PayPal", async () => {
  const { umgebung, daten } = baueUmgebung({ tabellen: { tariffs: [TARIF] } });
  const worker = await ladeWorker(umgebung);
  const anfrageMitPasswort = new Request("https://worker.test/api/admin/manuell-anlegen", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Passwort": "geheim" },
    body: JSON.stringify({ email: "feuerwehr@example.test", tariff_code: "foehr-jahr", zahlungsreferenz: "RG-2026-001" }),
  });
  const antwort = await worker.fetch(anfrageMitPasswort, { ...ENV, ADMIN_PASSWORT: "geheim" });
  assert.equal(antwort.status, 200);
  const ergebnis = await antwort.json();
  assert.ok(ergebnis.vertragsnummer);
  assert.equal(daten.customer_profiles.length, 1);
  assert.equal(daten.customer_profiles[0].email, "feuerwehr@example.test");
  assert.equal(daten.customer_profiles[0].auth_user_id, undefined, "noch nicht mit einer Anmeldung verknuepft");
  assert.equal(daten.subscriptions.length, 1);
  assert.equal(daten.subscriptions[0].status, "aktiv");
  assert.equal(daten.subscriptions[0].paypal_subscription_id, null);
  assert.ok(daten.subscriptions[0].notiz.includes("RG-2026-001"));
});

test("Admin: manueller Zugang ohne Passwort abgelehnt", async () => {
  const { umgebung, daten } = baueUmgebung({ tabellen: { tariffs: [TARIF] } });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/admin/manuell-anlegen", {
      methode: "POST",
      koerper: { email: "feuerwehr@example.test", tariff_code: "foehr-jahr" },
    }), { ...ENV, ADMIN_PASSWORT: "geheim" });
  assert.equal(antwort.status, 401);
  assert.equal((daten.customer_profiles || []).length, 0);
});

test("Erstes Login verknuepft ein manuell angelegtes Profil automatisch mit der Anmeldung", async () => {
  const { umgebung, daten } = baueUmgebung({
    tabellen: {
      customer_profiles: [{ id: "kunde-1", email: "kunde@example.test" }], // noch kein auth_user_id
      subscriptions: [{
        id: "abo-1", customer_id: "kunde-1", status: "aktiv",
        bezahlt_bis: "2099-01-01T00:00:00Z", tariffs: { max_geraete: 2 },
      }],
    },
  });
  const worker = await ladeWorker(umgebung);
  const antwort = await worker.fetch(
    anfrage("/api/zugriff?geraet=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { token: "gueltig" }), ENV);
  const ergebnis = await antwort.json();
  assert.equal(ergebnis.erlaubt, true);
  assert.equal(daten.customer_profiles[0].auth_user_id, "user-1", "wird beim ersten Zugriff automatisch verknuepft");
});
