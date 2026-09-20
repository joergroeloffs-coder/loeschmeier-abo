import { supabaseClient, pruefeNutzerToken } from "./supabase.js";
import { webhookIstEcht, holeAboDetails, kuendigeAbo } from "./paypal.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

      await db.insert("payments", [
        {
          subscription_id: abo.id,
          paypal_capture_id: resource.id,
          betrag_cent: Math.round(parseFloat(resource.amount?.total || "0") * 100),
          waehrung: resource.amount?.currency || "EUR",
          status: "erfolgreich",
        },
      ]);

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
      await db.update("payments", `paypal_capture_id=eq.${resource.sale_id}`, {
        status: "erstattet",
      });
      const subId = resource.billing_agreement_id;
      if (subId) {
        await db.update("subscriptions", `paypal_subscription_id=eq.${subId}`, {
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
