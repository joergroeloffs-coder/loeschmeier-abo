import { supabaseClient, pruefeNutzerToken, holeNutzer } from "./supabase.js";
import { webhookIstEcht, holeAboDetails, kuendigeAbo } from "./paypal.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Passwort",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(daten, status = 200) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook/paypal" && request.method === "POST") {
        return await verarbeiteWebhook(request, env);
      }
      if (url.pathname === "/api/zugriff" && request.method === "GET") {
        return await pruefeZugriff(request, env);
      }
      if (url.pathname === "/api/kuendigen" && request.method === "POST") {
        return await kundeKuendigt(request, env);
      }
      if (url.pathname === "/api/geraet-entfernen" && request.method === "POST") {
        return await kundeEntferntGeraet(request, env);
      }
      if (url.pathname === "/api/abo-anlegen" && request.method === "POST") {
        return await aboAnlegen(request, env);
      }
      if (url.pathname.startsWith("/api/admin/")) {
        return await adminAnfrage(request, env, url);
      }
      return json({ fehler: "Unbekannter Pfad" }, 404);
    } catch (e) {
      console.error(e);
      return json({ fehler: "Interner Fehler" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(taeglicherAbgleich(env));
  },
};

// ---------- Webhook ----------

async function verarbeiteWebhook(request, env) {
  const rohBody = await request.text();

  const echt = await webhookIstEcht(env, request.headers, rohBody);
  if (!echt) {
    // Nicht verifizierte Nachrichten duerfen NIE Daten aendern.
    return json({ fehler: "Signatur ungueltig" }, 400);
  }

  const ereignis = JSON.parse(rohBody);
  const db = supabaseClient(env);

  // Idempotenz: jedes PayPal-Ereignis nur einmal verarbeiten.
  const vorhanden = await db.select(
    "webhook_events",
    `paypal_event_id=eq.${ereignis.id}&select=id`
  );
  if (vorhanden.length > 0) {
    return json({ status: "bereits verarbeitet" });
  }

  let ergebnis = "ok";
  let fehlermeldung = null;
  try {
    await verarbeiteEreignis(db, env, ereignis);
  } catch (e) {
    ergebnis = "fehler";
    fehlermeldung = String(e).slice(0, 500);
  }

  await db.insert("webhook_events", [
    {
      paypal_event_id: ereignis.id,
      event_type: ereignis.event_type,
      paypal_subscription_id: ereignis.resource?.id || ereignis.resource?.billing_agreement_id || null,
      ergebnis,
      fehlermeldung,
    },
  ]);

  return json({ status: ergebnis });
}

async function verarbeiteEreignis(db, env, ereignis) {
  const typ = ereignis.event_type;
  const resource = ereignis.resource || {};

  switch (typ) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      await db.update("subscriptions", `paypal_subscription_id=eq.${resource.id}`, {
        status: "aktiv",
        paypal_payer_id: resource.subscriber?.payer_id || null,
        beginn: resource.start_time || new Date().toISOString(),
        naechste_zahlung: resource.billing_info?.next_billing_time || null,
        aktualisiert_am: new Date().toISOString(),
      });
      break;
    }

    case "PAYMENT.SALE.COMPLETED": {
      // Wiederkehrende Zahlung erfolgreich. billing_agreement_id ist die PayPal-Subscription-ID.
      const subId = resource.billing_agreement_id;
      if (!subId) break;
      const abos = await db.select("subscriptions", `paypal_subscription_id=eq.${subId}&select=id,status`);
      if (abos.length === 0) break;
      const abo = abos[0];

      const betragCent = Math.round(parseFloat(resource.amount?.total || "0") * 100);
      const neueZahlung = await db.insert("payments", [
        {
          subscription_id: abo.id,
          paypal_capture_id: resource.id,
          betrag_cent: betragCent,
          waehrung: resource.amount?.currency || "EUR",
          status: "erfolgreich",
        },
      ]);

      await erstelleRechnung(db, abo.id, neueZahlung[0].id, betragCent);

      // Aktiviert das Abo (falls es aus Kulanzzeit/ueberfaellig kam) und
      // aktualisiert den bezahlten Zeitraum anhand der aktuellen PayPal-Daten.
      const details = await holeAboDetails(env, subId);
      await db.update("subscriptions", `id=eq.${abo.id}`, {
        status: "aktiv",
        naechste_zahlung: details.billing_info?.next_billing_time || null,
        bezahlt_bis: details.billing_info?.next_billing_time || null,
        kulanz_bis: null,
        aktualisiert_am: new Date().toISOString(),
      });
      break;
    }

    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const abos = await db.select(
        "subscriptions",
        `paypal_subscription_id=eq.${resource.id}&select=id`
      );
      if (abos.length === 0) break;
      const kulanzTage = parseInt(env.KULANZ_TAGE || "3", 10);
      const kulanzBis = new Date(Date.now() + kulanzTage * 86400000).toISOString();
      await db.update("subscriptions", `id=eq.${abos[0].id}`, {
        status: "kulanzzeit",
        kulanz_bis: kulanzBis,
        aktualisiert_am: new Date().toISOString(),
      });
      break;
    }

    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.EXPIRED": {
      const neuerStatus = typ.endsWith("EXPIRED") ? "abgelaufen" : "gesperrt";
      await db.update("subscriptions", `paypal_subscription_id=eq.${resource.id}`, {
        status: neuerStatus,
        aktualisiert_am: new Date().toISOString(),
      });
      break;
    }

    case "BILLING.SUBSCRIPTION.CANCELLED": {
      // Kuendigung direkt bei PayPal (nicht ueber unsere App). Zugang bleibt
      // bis zum Ende des bezahlten Zeitraums bestehen (siehe pruefeZugriff),
      // aber der Status zeigt "gekuendigt".
      const abos = await db.select(
        "subscriptions",
        `paypal_subscription_id=eq.${resource.id}&select=id,bezahlt_bis`
      );
      if (abos.length === 0) break;
      await db.update("subscriptions", `id=eq.${abos[0].id}`, {
        status: "gekuendigt_zum_ende",
        gekuendigt_am: new Date().toISOString(),
        aktualisiert_am: new Date().toISOString(),
      });
      break;
    }

    case "PAYMENT.SALE.REFUNDED": {
      // PayPal liefert im Refund-Webhook keine verlaessliche billing_agreement_id
      // mit - die Zuordnung zum Abo holen wir stattdessen ueber unsere eigene
      // payments-Tabelle (subscription_id war dort schon beim urspruenglichen
      // Zahlungseingang gespeichert).
      const urspruenglicheSaleId = resource.sale_id || resource.parent_payment;
      const aktualisiertePayments = await db.update(
        "payments",
        `paypal_capture_id=eq.${urspruenglicheSaleId}`,
        { status: "erstattet" }
      );
      if (aktualisiertePayments.length > 0) {
        await db.update("subscriptions", `id=eq.${aktualisiertePayments[0].subscription_id}`, {
          status: "erstattet",
          aktualisiert_am: new Date().toISOString(),
        });
      }
      break;
    }

    default:
      // Andere Ereignistypen (CREATED, UPDATED, Dispute, ...) werden nur
      // protokolliert (siehe webhook_events), aber aendern nichts.
      break;
  }
}

// ---------- Zugriffspruefung (von der App bei jeder geschuetzten Aktion aufgerufen) ----------

const ERLAUBTE_STATUS = new Set(["aktiv", "kulanzzeit", "gekuendigt_zum_ende"]);
const MAX_GERAETE = 2;

async function pruefeZugriff(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const geraetId = new URL(request.url).searchParams.get("geraet");

  if (!accessToken || !geraetId) {
    return json({ erlaubt: false, grund: "fehlende_angaben" }, 400);
  }

  const authUserId = await pruefeNutzerToken(env, accessToken);
  if (!authUserId) {
    return json({ erlaubt: false, grund: "nicht_angemeldet" }, 401);
  }

  const db = supabaseClient(env);

  const profile = await db.select(
    "customer_profiles",
    `auth_user_id=eq.${authUserId}&select=id`
  );
  if (profile.length === 0) {
    return json({ erlaubt: false, grund: "kein_profil" });
  }
  const customerId = profile[0].id;

  const abos = await db.select(
    "subscriptions",
    `customer_id=eq.${customerId}&select=id,status,manuell_gesperrt,bezahlt_bis&order=erstellt_am.desc&limit=1`
  );
  if (abos.length === 0) {
    return json({ erlaubt: false, grund: "kein_abo" });
  }
  const abo = abos[0];

  if (abo.manuell_gesperrt) {
    return json({ erlaubt: false, grund: "manuell_gesperrt" });
  }
  if (!ERLAUBTE_STATUS.has(abo.status)) {
    return json({ erlaubt: false, grund: "abo_status_" + abo.status });
  }
  if (abo.status === "gekuendigt_zum_ende" && abo.bezahlt_bis && new Date(abo.bezahlt_bis) < new Date()) {
    return json({ erlaubt: false, grund: "bezahlter_zeitraum_beendet" });
  }

  // Geraet registrieren/aktualisieren, Geraetelimit pruefen.
  const geraete = await db.select(
    "devices",
    `customer_id=eq.${customerId}&select=id,geraet_name`
  );
  const bekannt = geraete.find((g) => g.geraet_name === geraetId);
  if (!bekannt) {
    if (geraete.length >= MAX_GERAETE) {
      return json({ erlaubt: false, grund: "geraetelimit_erreicht", maxGeraete: MAX_GERAETE });
    }
    await db.insert("devices", [{ customer_id: customerId, geraet_name: geraetId, bestaetigt: true }]);
  } else {
    await db.update("devices", `id=eq.${bekannt.id}`, { zuletzt_aktiv: new Date().toISOString() });
  }

  return json({ erlaubt: true, status: abo.status });
}

// ---------- Abo nach PayPal-Bestaetigung anlegen ----------
// Wird aufgerufen, sobald der Kunde den PayPal-Button bestaetigt hat
// (onApprove). Legt Kundenprofil (falls neu) und Abo mit Status
// "wird_geprueft" an - erst der Webhook BILLING.SUBSCRIPTION.ACTIVATED
// schaltet danach wirklich frei. Verhindert, dass allein die
// Rueckleitung von PayPal Zugang gewaehrt.

async function aboAnlegen(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const nutzer = await holeNutzer(env, accessToken);
  if (!nutzer) return json({ fehler: "nicht_angemeldet" }, 401);

  const body = await request.json().catch(() => ({}));
  const { paypal_subscription_id, tariff_code } = body;
  if (!paypal_subscription_id || !tariff_code) {
    return json({ fehler: "fehlende_angaben" }, 400);
  }

  const db = supabaseClient(env);

  let profile = await db.select(
    "customer_profiles",
    `auth_user_id=eq.${nutzer.id}&select=id`
  );
  let customerId;
  if (profile.length === 0) {
    const neu = await db.insert("customer_profiles", [
      { auth_user_id: nutzer.id, email: nutzer.email },
    ]);
    customerId = neu[0].id;
  } else {
    customerId = profile[0].id;
  }

  const tarife = await db.select("tariffs", `code=eq.${tariff_code}&select=id`);
  if (tarife.length === 0) return json({ fehler: "unbekannter_tarif" }, 400);

  // Verhindert Duplikate, falls der Kunde die Seite neu laedt.
  const vorhanden = await db.select(
    "subscriptions",
    `paypal_subscription_id=eq.${paypal_subscription_id}&select=id`
  );
  if (vorhanden.length > 0) {
    return json({ status: "bereits_angelegt" });
  }

  await db.insert("subscriptions", [
    {
      customer_id: customerId,
      tariff_id: tarife[0].id,
      status: "wird_geprueft",
      paypal_subscription_id,
    },
  ]);

  return json({ status: "angelegt" });
}

// ---------- Kuendigung durch Kunden ----------

async function kundeKuendigt(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const authUserId = await pruefeNutzerToken(env, accessToken);
  if (!authUserId) return json({ fehler: "nicht_angemeldet" }, 401);

  const db = supabaseClient(env);
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${authUserId}&select=id`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  const abos = await db.select(
    "subscriptions",
    `customer_id=eq.${profile[0].id}&status=eq.aktiv&select=id,paypal_subscription_id,bezahlt_bis&limit=1`
  );
  if (abos.length === 0) return json({ fehler: "kein_aktives_abo" }, 404);
  const abo = abos[0];

  const erfolgreich = await kuendigeAbo(env, abo.paypal_subscription_id, "Kuendigung durch Kunden im Kundenbereich");
  if (!erfolgreich) return json({ fehler: "paypal_kuendigung_fehlgeschlagen" }, 502);

  const jetzt = new Date().toISOString();
  await db.update("subscriptions", `id=eq.${abo.id}`, {
    status: "gekuendigt_zum_ende",
    gekuendigt_am: jetzt,
    aktualisiert_am: jetzt,
  });
  await db.insert("cancellations", [
    {
      subscription_id: abo.id,
      angefordert_am: jetzt,
      wirksam_zum: abo.bezahlt_bis || jetzt,
      bestaetigungstext: `Kuendigung am ${jetzt} bestaetigt. Zugang bleibt bis ${abo.bezahlt_bis || "Ende des bezahlten Zeitraums"} bestehen.`,
    },
  ]);

  return json({ status: "gekuendigt", wirksam_zum: abo.bezahlt_bis });
}

// ---------- Geraet durch Kunden entfernen ----------

async function kundeEntferntGeraet(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const authUserId = await pruefeNutzerToken(env, accessToken);
  if (!authUserId) return json({ fehler: "nicht_angemeldet" }, 401);

  const body = await request.json().catch(() => ({}));
  if (!body.device_id) return json({ fehler: "fehlende_angaben" }, 400);

  const db = supabaseClient(env);
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${authUserId}&select=id`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  // Nur loeschen, wenn das Geraet wirklich diesem Kunden gehoert (sonst
  // koennte ein Kunde ueber eine geratene ID fremde Geraete entfernen).
  const geraete = await db.select(
    "devices",
    `id=eq.${body.device_id}&customer_id=eq.${profile[0].id}&select=id`
  );
  if (geraete.length === 0) return json({ fehler: "geraet_nicht_gefunden" }, 404);

  await db.delete("devices", `id=eq.${body.device_id}`);
  return json({ status: "entfernt" });
}

// ---------- Rechnungsstellung ----------
// Automatisch bei jeder erfolgreichen Zahlung. Fortlaufende Nummer pro Jahr
// im Format JAHR-NNNN (z.B. 2026-0001), wie mit dem Betreiber festgelegt.

async function erstelleRechnung(db, subscriptionId, paymentId, betragCent) {
  const jahr = new Date().getFullYear();
  const bestehende = await db.select(
    "invoices",
    `rechnungsnummer=like.${jahr}-*&select=rechnungsnummer&order=rechnungsnummer.desc&limit=1`
  );

  let naechsteLaufnummer = 1;
  if (bestehende.length > 0) {
    const teile = bestehende[0].rechnungsnummer.split("-");
    naechsteLaufnummer = parseInt(teile[1], 10) + 1;
  }
  const rechnungsnummer = `${jahr}-${String(naechsteLaufnummer).padStart(4, "0")}`;

  await db.insert("invoices", [
    {
      subscription_id: subscriptionId,
      payment_id: paymentId,
      rechnungsnummer,
      betrag_cent: betragCent,
    },
  ]);
}

// ---------- Taeglicher Abgleich (faengt ausgefallene Webhooks ab) ----------

async function taeglicherAbgleich(env) {
  const db = supabaseClient(env);
  const abos = await db.select(
    "subscriptions",
    `status=in.(aktiv,kulanzzeit,ueberfaellig)&select=id,paypal_subscription_id,status`
  );

  for (const abo of abos) {
    if (!abo.paypal_subscription_id) continue;
    try {
      const details = await holeAboDetails(env, abo.paypal_subscription_id);
      const paypalStatus = (details.status || "").toUpperCase();

      let neuerStatus = null;
      if (paypalStatus === "ACTIVE") neuerStatus = "aktiv";
      else if (paypalStatus === "SUSPENDED") neuerStatus = "gesperrt";
      else if (paypalStatus === "CANCELLED") neuerStatus = "gekuendigt_zum_ende";
      else if (paypalStatus === "EXPIRED") neuerStatus = "abgelaufen";

      if (neuerStatus && neuerStatus !== abo.status) {
        await db.update("subscriptions", `id=eq.${abo.id}`, {
          status: neuerStatus,
          naechste_zahlung: details.billing_info?.next_billing_time || null,
          aktualisiert_am: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error(`Abgleich fehlgeschlagen fuer ${abo.paypal_subscription_id}:`, e);
    }
  }

  // Kulanzzeit abgelaufen ohne neue Zahlung -> sperren.
  const jetzt = new Date().toISOString();
  const abgelaufeneKulanz = await db.select(
    "subscriptions",
    `status=eq.kulanzzeit&kulanz_bis=lt.${jetzt}&select=id`
  );
  for (const abo of abgelaufeneKulanz) {
    await db.update("subscriptions", `id=eq.${abo.id}`, {
      status: "gesperrt",
      aktualisiert_am: jetzt,
    });
  }
}

// ---------- Admin-Bereich ----------
// Schutz per einfachem Passwort (env.ADMIN_PASSWORT), da nur eine Person
// (der Betreiber) Zugriff braucht - kein eigenes Nutzerkonto-System noetig.
// Zusaetzlich Rate Limiting ueber KV (env.RATE_KV), damit das Passwort
// nicht per Brute-Force durchprobiert werden kann.

const RATE_LIMIT_FENSTER_SEK = 60;
const RATE_LIMIT_MAX_VERSUCHE = 30; // grosszuegig fuer normale Nutzung, bremst aber Brute-Force deutlich

async function rateLimitUeberschritten(request, env) {
  if (!env.RATE_KV) return false; // KV noch nicht verknuepft - dann kein Limit
  const ip = request.headers.get("CF-Connecting-IP") || "unbekannt";
  const key = "admin_versuche:" + ip;

  const aktuellRoh = await env.RATE_KV.get(key);
  const aktuell = aktuellRoh ? parseInt(aktuellRoh, 10) : 0;

  if (aktuell >= RATE_LIMIT_MAX_VERSUCHE) return true;

  await env.RATE_KV.put(key, String(aktuell + 1), { expirationTtl: RATE_LIMIT_FENSTER_SEK });
  return false;
}

function adminAutorisiert(request, env) {
  const passwort = request.headers.get("X-Admin-Passwort") || "";
  return env.ADMIN_PASSWORT && passwort === env.ADMIN_PASSWORT;
}

async function adminAnfrage(request, env, url) {
  if (await rateLimitUeberschritten(request, env)) {
    return json({ fehler: "zu_viele_versuche_bitte_warten" }, 429);
  }
  if (!adminAutorisiert(request, env)) {
    return json({ fehler: "nicht_autorisiert" }, 401);
  }

  const db = supabaseClient(env);
  const pfad = url.pathname;

  if (pfad === "/api/admin/uebersicht" && request.method === "GET") {
    return json(await adminUebersicht(db));
  }
  if (pfad === "/api/admin/kunden" && request.method === "GET") {
    const kunden = await db.select(
      "subscriptions",
      "select=id,status,beginn,naechste_zahlung,bezahlt_bis,gekuendigt_am,manuell_gesperrt,notiz,paypal_subscription_id,customer_profiles(email),tariffs(bezeichnung,preis_cent)&order=erstellt_am.desc"
    );
    return json(kunden);
  }
  if (pfad === "/api/admin/sperren" && request.method === "POST") {
    return await adminAktion(request, env, db, "sperren", { manuell_gesperrt: true });
  }
  if (pfad === "/api/admin/entsperren" && request.method === "POST") {
    return await adminAktion(request, env, db, "entsperren", { manuell_gesperrt: false });
  }
  if (pfad === "/api/admin/kulanz-verlaengern" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const tage = parseInt(body.tage || "3", 10);
    const kulanzBis = new Date(Date.now() + tage * 86400000).toISOString();
    return await adminAktion(request, env, db, "kulanz_verlaengert", {
      status: "kulanzzeit",
      kulanz_bis: kulanzBis,
    });
  }
  if (pfad === "/api/admin/geraete-zuruecksetzen" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.customer_id) return json({ fehler: "fehlende_angaben" }, 400);
    return await adminGeraeteZuruecksetzen(env, db, body.customer_id);
  }

  return json({ fehler: "unbekannter_admin_pfad" }, 404);
}

async function adminUebersicht(db) {
  const alle = await db.select("subscriptions", "select=status,tariffs(preis_cent)");
  const zaehler = {};
  let monatsUmsatzCent = 0;
  for (const s of alle) {
    zaehler[s.status] = (zaehler[s.status] || 0) + 1;
    if (s.status === "aktiv") monatsUmsatzCent += s.tariffs?.preis_cent || 0;
  }
  const fehlerhafteWebhooks = await db.select(
    "webhook_events",
    "select=id&ergebnis=eq.fehler&order=verarbeitet_am.desc&limit=20"
  );
  return {
    gesamtKunden: alle.length,
    proStatus: zaehler,
    monatsUmsatzCent,
    webhookFehlerAnzahl: fehlerhafteWebhooks.length,
  };
}

async function adminAktion(request, env, db, aktionsName, patch) {
  const body = await request.json().catch(() => ({}));
  if (!body.subscription_id) return json({ fehler: "fehlende_angaben" }, 400);

  await db.update("subscriptions", `id=eq.${body.subscription_id}`, {
    ...patch,
    aktualisiert_am: new Date().toISOString(),
  });
  await db.insert("admin_actions", [
    {
      admin_name: "Joerg",
      aktion: aktionsName,
      subscription_id: body.subscription_id,
      details: body.notiz || null,
    },
  ]);
  return json({ status: "ok" });
}

async function adminGeraeteZuruecksetzen(env, db, customerId) {
  const geraete = await db.select("devices", `customer_id=eq.${customerId}&select=id`);
  for (const g of geraete) {
    await db.update("devices", `id=eq.${g.id}`, { bestaetigt: false });
  }
  // Loeschen statt nur markieren, damit sofort wieder neue Geraete moeglich sind.
  await fetch(`${env.SUPABASE_URL}/rest/v1/devices?customer_id=eq.${customerId}`, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  await db.insert("admin_actions", [
    { admin_name: "Joerg", aktion: "geraete_zurueckgesetzt", customer_id: customerId },
  ]);
  return json({ status: "ok" });
}
