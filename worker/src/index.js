import { supabaseClient, pruefeNutzerToken, holeNutzer } from "./supabase.js";
import { webhookIstEcht, holeAboDetails, kuendigeAbo, erstatteZahlung } from "./paypal.js";
import {
  LEGAL_VERSION,
  calculateProRataRefund,
  createContractNumber,
  declarationConfirmation,
  sendTextEmail,
  validatePublicDeclaration,
} from "./legal.js";

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
      if (url.pathname === "/api/katalog" && request.method === "GET") {
        return await katalog(env);
      }
      if (url.pathname === "/api/kuendigung-erklaeren" && request.method === "POST") {
        return await rechtserklaerung(request, env, "kuendigung");
      }
      if (url.pathname === "/api/widerrufen" && request.method === "POST") {
        return await rechtserklaerung(request, env, "widerruf");
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
    ctx.waitUntil(Promise.all([taeglicherAbgleich(env), versendeAusstehendeNachrichten(env)]));
  },
};

function filterWert(value) {
  return encodeURIComponent(String(value || ""));
}

function verkaufBereit(env) {
  return env.SALES_ENABLED === "true" && Boolean(env.RESEND_API_KEY && env.TRANSACTIONAL_FROM);
}

async function katalog(env) {
  const db = supabaseClient(env);
  const tarife = await db.select(
    "tariffs",
    "aktiv=eq.true&oeffentlich=eq.true&select=code,slug,bezeichnung,beschreibung,preis_cent,waehrung,intervall,max_geraete,paypal_plan_id"
  );
  return json({
    verkaufAktiv: verkaufBereit(env),
    rechtstexteVersion: LEGAL_VERSION,
    paypalClientId: verkaufBereit(env) ? env.PAYPAL_CLIENT_ID : null,
    tarife: tarife.map(({ paypal_plan_id, ...tarif }) => ({
      ...tarif,
      kaufbar: verkaufBereit(env) && Boolean(paypal_plan_id),
      paypalPlanId: verkaufBereit(env) ? paypal_plan_id : null,
    })),
  });
}

async function nachrichtVormerken(db, env, { customerId = null, declarationId = null, to, subject, text }) {
  const rows = await db.insert("outbound_messages", [{
    customer_id: customerId,
    legal_declaration_id: declarationId,
    empfaenger: to,
    betreff: subject,
    inhalt: text,
  }]);
  try {
    await sendTextEmail(env, { to, subject, text, idempotencyKey: `outbound/${rows[0].id}` });
    await db.update("outbound_messages", `id=eq.${rows[0].id}`, {
      status: "gesendet",
      versuche: 1,
      gesendet_am: new Date().toISOString(),
    });
  } catch (error) {
    await db.update("outbound_messages", `id=eq.${rows[0].id}`, {
      status: "ausstehend",
      versuche: 1,
      letzter_fehler: String(error).slice(0, 500),
    });
  }
}

async function versendeAusstehendeNachrichten(env) {
  if (!env.RESEND_API_KEY || !env.TRANSACTIONAL_FROM) return;
  const db = supabaseClient(env);
  const messages = await db.select(
    "outbound_messages",
    "status=eq.ausstehend&versuche=lt.8&select=id,empfaenger,betreff,inhalt,versuche&order=erstellt_am.asc&limit=25"
  );
  for (const message of messages) {
    try {
      await sendTextEmail(env, {
        to: message.empfaenger,
        subject: message.betreff,
        text: message.inhalt,
        idempotencyKey: `outbound/${message.id}`,
      });
      await db.update("outbound_messages", `id=eq.${message.id}`, {
        status: "gesendet",
        versuche: message.versuche + 1,
        letzter_fehler: null,
        gesendet_am: new Date().toISOString(),
      });
    } catch (error) {
      await db.update("outbound_messages", `id=eq.${message.id}`, {
        versuche: message.versuche + 1,
        letzter_fehler: String(error).slice(0, 500),
      });
    }
  }
}

async function rechtserklaerung(request, env, type) {
  if (await rechtserklaerungRateLimit(request, env)) {
    return json({ fehler: "zu_viele_versuche_bitte_spaeter_erneut" }, 429);
  }
  const body = await request.json().catch(() => ({}));
  const validation = validatePublicDeclaration(body, type);
  if (!validation.ok) return json({ fehler: validation.error }, 400);

  const data = validation.value;
  const db = supabaseClient(env);
  const profiles = await db.select(
    "customer_profiles",
    `email=eq.${filterWert(data.email)}&select=id,email`
  );
  let subscription = null;
  let customerId = null;
  if (profiles.length > 0) {
    customerId = profiles[0].id;
    const subscriptions = await db.select(
      "subscriptions",
      `customer_id=eq.${customerId}&select=id,vertragsnummer,paypal_subscription_id,status,bezahlt_bis,mindestlaufzeit_bis`
    );
    subscription = subscriptions.find((entry) =>
      entry.vertragsnummer === data.contractReference || entry.paypal_subscription_id === data.contractReference
    ) || null;
  }

  const now = new Date().toISOString();
  let effectiveAt = null;
  let processingStatus = subscription ? "zugeordnet" : "manuelle_pruefung";
  let cancellationRefundCents = 0;
  let refunded = false;
  if (subscription) {
    if (type === "kuendigung") {
      const result = await kuendigungVerarbeiten(db, env, subscription, data.requestedEnd);
      effectiveAt = result.effectiveAt;
      processingStatus = result.processingStatus;
      cancellationRefundCents = result.refundedCents;
    } else if (subscription.paypal_subscription_id && !["abgelaufen", "widerrufen", "erstattet"].includes(subscription.status)) {
      const cancelled = await kuendigeAbo(
        env,
        subscription.paypal_subscription_id,
        "Widerruf durch Kunden"
      );
      if (!cancelled) processingStatus = "paypal_pruefung_noetig";
    }
    if (type === "widerruf") {
      const payments = await db.select(
        "payments",
        `subscription_id=eq.${subscription.id}&status=eq.erfolgreich&select=id,paypal_capture_id,betrag_cent&order=zeitpunkt.desc&limit=1`
      );
      if (payments.length > 0 && payments[0].paypal_capture_id) {
        try {
          await erstatteZahlung(env, payments[0].paypal_capture_id);
          await db.update("payments", `id=eq.${payments[0].id}`, {
            status: "erstattet",
            erstattet_cent: payments[0].betrag_cent,
            erstattet_am: now,
          });
          refunded = true;
          processingStatus = "erstattet";
        } catch (error) {
          console.error("Automatische Widerrufserstattung fehlgeschlagen", error);
          processingStatus = "erstattung_manuell_pruefen";
        }
      } else {
        processingStatus = "keine_zahlung_gefunden";
      }
    }
    if (type === "widerruf") {
      effectiveAt = now;
      await db.update("subscriptions", `id=eq.${subscription.id}`, {
        status: refunded ? "erstattet" : "widerrufen",
        gekuendigt_am: now,
        kuendigungswirksam_am: now,
        aktualisiert_am: now,
      });
    }
  }

  const declarationText = type === "widerruf"
    ? `Hiermit widerrufe ich den Vertrag ${data.contractReference}.`
    : `Hiermit kündige ich den Vertrag ${data.contractReference} ${data.declarationKind}.`;
  const rows = await db.insert("legal_declarations", [{
    typ: type,
    subscription_id: subscription?.id || null,
    name: data.name,
    email: data.email,
    vertragsreferenz: data.contractReference,
    vertragsbezeichnung: data.contractLabel,
    erklaerungsart: data.declarationKind,
    grund: data.reason,
    gewuenschtes_ende: data.requestedEnd?.toISOString() || null,
    wirksam_zum: effectiveAt,
    erklaerungstext: declarationText,
    zugeordnet: Boolean(subscription),
    verarbeitungsstatus: processingStatus,
  }]);
  let confirmation = declarationConfirmation({
    type,
    receiptId: rows[0].id,
    receivedAt: now,
    data,
    effectiveAt,
  });
  if (type === "widerruf") {
    confirmation += refunded
      ? "\n\nDie über PayPal erfasste Zahlung wurde zur vollständigen Erstattung angewiesen."
      : "\n\nEine etwaige Zahlung wird unverzüglich geprüft und spätestens innerhalb der gesetzlichen Frist erstattet.";
  } else if (cancellationRefundCents > 0) {
    confirmation += `\n\nAnteilige Erstattung angewiesen: ${(cancellationRefundCents / 100).toFixed(2).replace(".", ",")} EUR.`;
  }
  await db.update("legal_declarations", `id=eq.${rows[0].id}`, { bestaetigt_am: now });
  await nachrichtVormerken(db, env, {
    customerId,
    declarationId: rows[0].id,
    to: data.email,
    subject: `${type === "widerruf" ? "Widerruf" : "Kündigung"} – Eingangsbestätigung ${rows[0].id}`,
    text: confirmation,
  });

  return json({
    status: "eingegangen",
    vorgangsnummer: rows[0].id,
    eingegangen_am: now,
    bestaetigung: confirmation,
  });
}

async function kuendigungVerarbeiten(db, env, subscription, requestedEnd = null) {
  const now = new Date();
  const minimumEnd = subscription.mindestlaufzeit_bis
    ? new Date(subscription.mindestlaufzeit_bis)
    : new Date(subscription.bezahlt_bis || now);
  const paidUntil = new Date(subscription.bezahlt_bis || minimumEnd);
  let effective = now < minimumEnd ? minimumEnd : now;
  if (requestedEnd && requestedEnd > effective) effective = requestedEnd;
  if (effective > paidUntil) effective = paidUntil;

  let processingStatus = "zugeordnet";
  let refundedCents = 0;
  if (subscription.paypal_subscription_id && !["abgelaufen", "widerrufen", "erstattet"].includes(subscription.status)) {
    const cancelled = await kuendigeAbo(env, subscription.paypal_subscription_id, "Kündigung durch Kunden");
    if (!cancelled) processingStatus = "paypal_pruefung_noetig";
  }

  // Nach der Mindestlaufzeit darf jederzeit beendet werden. Eine bereits
  // gezahlte Jahresrate wird fuer die ungenutzte Restzeit anteilig erstattet.
  if (now >= minimumEnd && effective < paidUntil) {
    const payments = await db.select(
      "payments",
      `subscription_id=eq.${subscription.id}&status=in.(erfolgreich,teilweise_erstattet)&select=id,paypal_capture_id,betrag_cent,waehrung,zeitpunkt,erstattet_cent&order=zeitpunkt.desc&limit=1`
    );
    if (payments.length > 0 && payments[0].paypal_capture_id) {
      const payment = payments[0];
      const refundCents = Math.min(
        payment.betrag_cent - (payment.erstattet_cent || 0),
        calculateProRataRefund({
          amountCents: payment.betrag_cent,
          periodStart: payment.zeitpunkt,
          periodEnd: paidUntil,
          effectiveAt: effective,
        })
      );
      if (refundCents > 0) {
        try {
          await erstatteZahlung(env, payment.paypal_capture_id, {
            value: (refundCents / 100).toFixed(2),
            currency: payment.waehrung,
          });
          const totalRefunded = (payment.erstattet_cent || 0) + refundCents;
          await db.update("payments", `id=eq.${payment.id}`, {
            status: totalRefunded >= payment.betrag_cent ? "erstattet" : "teilweise_erstattet",
            erstattet_cent: totalRefunded,
            erstattet_am: now.toISOString(),
          });
          refundedCents = refundCents;
          processingStatus = "anteilig_erstattet";
        } catch (error) {
          console.error("Anteilige Erstattung fehlgeschlagen", error);
          processingStatus = "erstattung_manuell_pruefen";
        }
      }
    } else {
      processingStatus = "erstattung_manuell_pruefen";
    }
  }

  await db.update("subscriptions", `id=eq.${subscription.id}`, {
    status: "gekuendigt_zum_ende",
    gekuendigt_am: now.toISOString(),
    kuendigungswirksam_am: effective.toISOString(),
    aktualisiert_am: now.toISOString(),
  });
  return { effectiveAt: effective.toISOString(), processingStatus, refundedCents };
}

async function rechtserklaerungRateLimit(request, env) {
  if (!env.RATE_KV) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unbekannt";
  const key = `rechtserklaerung:${ip}`;
  const current = parseInt((await env.RATE_KV.get(key)) || "0", 10);
  if (current >= 10) return true;
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return false;
}

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
    `paypal_event_id=eq.${filterWert(ereignis.id)}&select=id,ergebnis`
  );
  if (vorhanden.length > 0 && vorhanden[0].ergebnis === "ok") {
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

  const protokoll = {
    event_type: ereignis.event_type,
    paypal_subscription_id: ereignis.resource?.id || ereignis.resource?.billing_agreement_id || null,
    verarbeitet_am: new Date().toISOString(),
    ergebnis,
    fehlermeldung,
  };
  if (vorhanden.length > 0) {
    await db.update("webhook_events", `id=eq.${vorhanden[0].id}`, protokoll);
  } else {
    await db.insert("webhook_events", [{ paypal_event_id: ereignis.id, ...protokoll }]);
  }

  // PayPal wiederholt Webhooks nur bei einem Fehlerstatus. So gehen
  // voruebergehende Datenbank- oder Netzwerkfehler nicht still verloren.
  return json({ status: ergebnis }, ergebnis === "ok" ? 200 : 500);
}

async function verarbeiteEreignis(db, env, ereignis) {
  const typ = ereignis.event_type;
  const resource = ereignis.resource || {};

  switch (typ) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const abos = await db.select(
        "subscriptions",
        `paypal_subscription_id=eq.${filterWert(resource.id)}&select=id,sofortiger_beginn,leistungsbeginn_am`
      );
      if (abos.length === 0) throw new Error("PayPal-Abo ist lokal noch nicht angelegt");
      const leistungsbeginn = abos[0].leistungsbeginn_am
        ? new Date(abos[0].leistungsbeginn_am)
        : new Date();
      const darfStarten = abos[0].sofortiger_beginn || leistungsbeginn <= new Date();
      await db.update("subscriptions", `paypal_subscription_id=eq.${resource.id}`, {
        status: darfStarten ? "aktiv" : "wartet_auf_leistungsbeginn",
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
      const abos = await db.select(
        "subscriptions",
        `paypal_subscription_id=eq.${filterWert(subId)}&select=id,status,sofortiger_beginn,leistungsbeginn_am,bezahlt_bis,tariffs(preis_cent,waehrung)`
      );
      if (abos.length === 0) throw new Error("PayPal-Zahlung kann noch keinem lokalen Abo zugeordnet werden");
      const abo = abos[0];

      const betragCent = Math.round(parseFloat(resource.amount?.total || "0") * 100);
      if (
        betragCent !== abo.tariffs?.preis_cent ||
        String(resource.amount?.currency || "").toUpperCase() !== String(abo.tariffs?.waehrung || "").toUpperCase()
      ) {
        throw new Error("PayPal-Zahlung stimmt nicht mit dem gebuchten Tarif ueberein");
      }
      let zahlungen = await db.select(
        "payments",
        `paypal_capture_id=eq.${filterWert(resource.id)}&select=id`
      );
      if (zahlungen.length === 0) {
        zahlungen = await db.insert("payments", [
          {
            subscription_id: abo.id,
            paypal_capture_id: resource.id,
            betrag_cent: betragCent,
            waehrung: resource.amount?.currency || "EUR",
            status: "erfolgreich",
          },
        ]);
      }
      const rechnungen = await db.select("invoices", `payment_id=eq.${zahlungen[0].id}&select=id`);
      if (rechnungen.length === 0) {
        await erstelleRechnung(db, abo.id, zahlungen[0].id, betragCent);
      }

      // Aktiviert das Abo (falls es aus Kulanzzeit/ueberfaellig kam) und
      // aktualisiert den bezahlten Zeitraum anhand der aktuellen PayPal-Daten.
      const details = await holeAboDetails(env, subId);
      const darfStarten = abo.sofortiger_beginn || (abo.leistungsbeginn_am && new Date(abo.leistungsbeginn_am) <= new Date());
      await db.update("subscriptions", `id=eq.${abo.id}`, {
        status: darfStarten ? "aktiv" : "wartet_auf_leistungsbeginn",
        naechste_zahlung: details.billing_info?.next_billing_time || null,
        bezahlt_bis: details.billing_info?.next_billing_time || abo.bezahlt_bis,
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
        { status: "erstattet", erstattet_am: new Date().toISOString() }
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
    `customer_id=eq.${customerId}&select=id,status,manuell_gesperrt,bezahlt_bis,kuendigungswirksam_am&order=erstellt_am.desc&limit=1`
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
  if (abo.status === "gekuendigt_zum_ende" && !abo.bezahlt_bis) {
    return json({ erlaubt: false, grund: "vertragsende_ungeklaert" });
  }
  if (abo.kuendigungswirksam_am && new Date(abo.kuendigungswirksam_am) <= new Date()) {
    return json({ erlaubt: false, grund: "kuendigung_wirksam" });
  }
  if (abo.bezahlt_bis && new Date(abo.bezahlt_bis) < new Date()) {
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
  if (!verkaufBereit(env)) return json({ fehler: "verkauf_nicht_freigeschaltet" }, 503);
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const nutzer = await holeNutzer(env, accessToken);
  if (!nutzer) return json({ fehler: "nicht_angemeldet" }, 401);

  const body = await request.json().catch(() => ({}));
  const { paypal_subscription_id, tariff_code } = body;
  if (!paypal_subscription_id || !tariff_code || body.agb_akzeptiert !== true || typeof body.sofortiger_beginn !== "boolean") {
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

  const tarife = await db.select(
    "tariffs",
    `code=eq.${filterWert(tariff_code)}&aktiv=eq.true&oeffentlich=eq.true&select=id,code,bezeichnung,preis_cent,waehrung,paypal_plan_id`
  );
  if (tarife.length === 0 || !tarife[0].paypal_plan_id) {
    return json({ fehler: "unbekannter_oder_nicht_kaufbarer_tarif" }, 400);
  }

  // Browserdaten sind nicht vertrauenswuerdig: Abo, Plan, Status und die beim
  // Erstellen eingebettete Supabase-Nutzer-ID werden direkt bei PayPal geprueft.
  const paypalDetails = await holeAboDetails(env, paypal_subscription_id);
  const paypalStatus = String(paypalDetails.status || "").toUpperCase();
  if (paypalDetails.plan_id !== tarife[0].paypal_plan_id || !["APPROVAL_PENDING", "APPROVED", "ACTIVE"].includes(paypalStatus)) {
    return json({ fehler: "paypal_abo_ungueltig" }, 400);
  }
  if (paypalDetails.custom_id !== nutzer.id) {
    return json({ fehler: "paypal_abo_gehoert_nicht_zum_konto" }, 400);
  }

  // Verhindert Duplikate, falls der Kunde die Seite neu laedt.
  const vorhanden = await db.select(
    "subscriptions",
    `paypal_subscription_id=eq.${filterWert(paypal_subscription_id)}&select=id,vertragsnummer,leistungsbeginn_am`
  );
  if (vorhanden.length > 0) {
    return json({
      status: "bereits_angelegt",
      vertragsnummer: vorhanden[0].vertragsnummer,
      leistungsbeginn_am: vorhanden[0].leistungsbeginn_am,
    });
  }

  const andereVertraege = await db.select(
    "subscriptions",
    `customer_id=eq.${customerId}&status=in.(wird_geprueft,wartet_auf_leistungsbeginn,aktiv,kulanzzeit,gekuendigt_zum_ende)&select=id&limit=1`
  );
  if (andereVertraege.length > 0) {
    await kuendigeAbo(env, paypal_subscription_id, "Doppelte Bestellung verhindert");
    return json({ fehler: "jahreszugang_bereits_vorhanden" }, 409);
  }

  const now = new Date();
  const paypalStart = paypalDetails.start_time ? new Date(paypalDetails.start_time) : now;
  const performanceStart = body.sofortiger_beginn ? now : paypalStart;
  if (!body.sofortiger_beginn) {
    const delayDays = (performanceStart.getTime() - now.getTime()) / 86400000;
    if (!Number.isFinite(delayDays) || delayDays < 13 || delayDays > 15) {
      return json({ fehler: "paypal_leistungsbeginn_ungueltig" }, 400);
    }
  }
  const contractEnd = new Date(performanceStart);
  contractEnd.setUTCFullYear(contractEnd.getUTCFullYear() + 1);
  const contractNumber = createContractNumber(now);
  const subscriptions = await db.insert("subscriptions", [
    {
      customer_id: customerId,
      tariff_id: tarife[0].id,
      status: "wird_geprueft",
      paypal_subscription_id,
      vertragsnummer: contractNumber,
      sofortiger_beginn: body.sofortiger_beginn,
      leistungsbeginn_am: performanceStart.toISOString(),
      mindestlaufzeit_bis: contractEnd.toISOString(),
      bezahlt_bis: contractEnd.toISOString(),
      agb_version: LEGAL_VERSION,
      widerruf_version: LEGAL_VERSION,
      datenschutz_version: LEGAL_VERSION,
    },
  ]);

  await db.insert("legal_acceptances", [{
    subscription_id: subscriptions[0].id,
    agb_version: LEGAL_VERSION,
    widerruf_version: LEGAL_VERSION,
    datenschutz_version: LEGAL_VERSION,
    agb_akzeptiert: true,
    sofortiger_beginn: body.sofortiger_beginn,
  }]);

  const confirmation = [
    "Vertragsbestätigung – Löschbärt Föhr Jahreszugang",
    "",
    `Vertragsnummer: ${contractNumber}`,
    `Tarif: ${tarife[0].bezeichnung}`,
    `Preis: ${(tarife[0].preis_cent / 100).toFixed(2).replace(".", ",")} ${tarife[0].waehrung} je 12 Monate`,
    `Vertragsschluss: ${now.toISOString()}`,
    `Leistungsbeginn: ${performanceStart.toISOString()}`,
    `Mindestlaufzeit bis: ${contractEnd.toISOString()}`,
    "Danach verlängert sich der Vertrag auf unbestimmte Zeit. Die Vergütung von 12,00 EUR wird jeweils für zwölf Monate im Voraus berechnet. Ab Ende der Mindestlaufzeit kann jederzeit gekündigt werden; ungenutzte vorausbezahlte Restzeit wird anteilig erstattet.",
    `Rechtstexte-Version: ${LEGAL_VERSION}`,
    body.sofortiger_beginn
      ? "Sie haben ausdrücklich verlangt, dass die Leistung vor Ablauf der Widerrufsfrist beginnt."
      : "Die Leistung beginnt nach Ablauf der 14-tägigen Widerrufsfrist.",
    "",
    "Anbieter: Jörg Roeloffs, Scholkwai 86, 25938 Süderende, Telefon 01724149356, wasserentnahme-foehr@web.de",
    "Leistung: Browserbasierte Föhr-Karte mit Wasserentnahmestellen und Defibrillatoren; Nutzung auf bis zu zwei registrierten Geräten.",
    "Technische Voraussetzungen: aktueller Browser und Internetzugang; nach dem ersten Laden sind Teile der Anwendung offline nutzbar.",
    "Zahlung: jährlich im Voraus über PayPal. Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen.",
    "Mängelrechte: Es gelten die gesetzlichen Rechte für digitale Produkte nach §§ 327 ff. BGB einschließlich erforderlicher Sicherheitsaktualisierungen.",
    "Kündigung: im Kundenbereich oder ohne Anmeldung unter https://test.roewise.com/kuendigen.html.",
    "",
    "Widerrufsbelehrung",
    "Sie können den Vertrag binnen vierzehn Tagen ab Vertragsschluss ohne Angabe von Gründen widerrufen. Senden Sie dazu eine eindeutige Erklärung an den Anbieter oder nutzen Sie https://test.roewise.com/widerruf.html. Zur Fristwahrung genügt die rechtzeitige Absendung. Nach Widerruf werden erhaltene Zahlungen unverzüglich und spätestens binnen vierzehn Tagen mit demselben Zahlungsmittel zurückgezahlt. Bei ausdrücklich verlangtem vorzeitigem Leistungsbeginn kann Wertersatz für die bis zum Widerruf erbrachte Leistung anfallen.",
    "Muster: Hiermit widerrufe ich den von mir abgeschlossenen Vertrag über den Löschbärt Föhr Jahreszugang. Name, Anschrift, Bestelldatum, Datum.",
    "",
    `Vereinbarte AGB (Fassung ${LEGAL_VERSION}): Der Zugang ist persönlich und auf zwei registrierte Geräte begrenzt. Zugangsdaten dürfen nicht an Dritte weitergegeben werden. Die Mindestlaufzeit beträgt zwölf Monate ab Leistungsbeginn. Danach läuft der Vertrag unbefristet weiter und kann jederzeit beendet werden; für ungenutzte vorausbezahlte Restzeit erfolgt eine anteilige Erstattung. Erforderliche Aktualisierungen einschließlich Sicherheitsaktualisierungen werden während des Bereitstellungszeitraums bereitgestellt. Es gelten die gesetzlichen Mängelrechte. Der Anbieter haftet unbeschränkt für Vorsatz, grobe Fahrlässigkeit, Schäden an Leben, Körper oder Gesundheit, nach dem Produkthaftungsgesetz und im Umfang übernommener Garantien. Bei leicht fahrlässiger Verletzung wesentlicher Vertragspflichten ist die Haftung auf den typischen vorhersehbaren Schaden begrenzt; im Übrigen ist sie, soweit gesetzlich zulässig, ausgeschlossen. Deutsches Recht gilt unter Wahrung zwingender Verbraucherschutzvorschriften. Der Anbieter nimmt nicht an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teil.`,
    "Zusätzliche lesbare Fassung: https://test.roewise.com/agb.html",
    "Datenschutz: https://test.roewise.com/datenschutz.html",
  ].join("\n");
  await nachrichtVormerken(db, env, {
    customerId,
    to: nutzer.email,
    subject: `Vertragsbestätigung ${contractNumber}`,
    text: confirmation,
  });

  return json({ status: "angelegt", vertragsnummer: contractNumber, leistungsbeginn_am: performanceStart.toISOString() });
}

// ---------- Kuendigung durch Kunden ----------

async function kundeKuendigt(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const authUserId = await pruefeNutzerToken(env, accessToken);
  if (!authUserId) return json({ fehler: "nicht_angemeldet" }, 401);

  const db = supabaseClient(env);
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${authUserId}&select=id,email`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  const abos = await db.select(
    "subscriptions",
    `customer_id=eq.${profile[0].id}&status=in.(wird_geprueft,aktiv,kulanzzeit,wartet_auf_leistungsbeginn)&select=id,status,paypal_subscription_id,bezahlt_bis,mindestlaufzeit_bis,vertragsnummer,tariffs(bezeichnung)&limit=1`
  );
  if (abos.length === 0) return json({ fehler: "kein_aktives_abo" }, 404);
  const abo = abos[0];

  const jetzt = new Date().toISOString();
  const result = await kuendigungVerarbeiten(db, env, abo);
  await db.insert("cancellations", [
    {
      subscription_id: abo.id,
      angefordert_am: jetzt,
      wirksam_zum: result.effectiveAt,
      bestaetigungstext: `Kündigung am ${jetzt} bestätigt. Vertragsende: ${result.effectiveAt}. Bearbeitungsstatus: ${result.processingStatus}.`,
    },
  ]);

  const confirmation = [
    "Kündigungsbestätigung",
    "",
    `Vertragsnummer: ${abo.vertragsnummer || abo.paypal_subscription_id}`,
    `Vertrag: ${abo.tariffs?.bezeichnung || "Löschbärt Föhr"}`,
    `Eingegangen am: ${jetzt}`,
    `Vertragsende: ${result.effectiveAt}`,
    `Bearbeitungsstatus: ${result.processingStatus}`,
    result.refundedCents > 0
      ? `Anteilige Erstattung: ${(result.refundedCents / 100).toFixed(2).replace(".", ",")} EUR`
      : null,
  ].filter(Boolean).join("\n");
  await nachrichtVormerken(db, env, {
    customerId: profile[0].id,
    to: profile[0].email,
    subject: `Kündigungsbestätigung ${abo.vertragsnummer || ""}`.trim(),
    text: confirmation,
  });

  return json({ status: "gekuendigt", wirksam_zum: result.effectiveAt, bestaetigung: confirmation });
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
  const rechnungsnummer = await db.rpc("next_invoice_number");

  await db.insert("invoices", [
    {
      subscription_id: subscriptionId,
      payment_id: paymentId,
      rechnungsnummer: typeof rechnungsnummer === "string" ? rechnungsnummer : String(rechnungsnummer),
      betrag_cent: betragCent,
    },
  ]);
}

// ---------- Taeglicher Abgleich (faengt ausgefallene Webhooks ab) ----------

async function taeglicherAbgleich(env) {
  const db = supabaseClient(env);
  const abos = await db.select(
    "subscriptions",
    `status=in.(wird_geprueft,aktiv,kulanzzeit,ueberfaellig,wartet_auf_leistungsbeginn)&select=id,paypal_subscription_id,status,sofortiger_beginn,leistungsbeginn_am`
  );

  for (const abo of abos) {
    if (!abo.paypal_subscription_id) continue;
    try {
      const details = await holeAboDetails(env, abo.paypal_subscription_id);
      const paypalStatus = (details.status || "").toUpperCase();

      let neuerStatus = null;
      if (paypalStatus === "ACTIVE") {
        const darfStarten = abo.sofortiger_beginn || (abo.leistungsbeginn_am && new Date(abo.leistungsbeginn_am) <= new Date());
        neuerStatus = darfStarten ? "aktiv" : "wartet_auf_leistungsbeginn";
      }
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
  let gebuchtesVolumenCent = 0;
  for (const s of alle) {
    zaehler[s.status] = (zaehler[s.status] || 0) + 1;
    if (["aktiv", "wartet_auf_leistungsbeginn"].includes(s.status)) {
      gebuchtesVolumenCent += s.tariffs?.preis_cent || 0;
    }
  }
  const fehlerhafteWebhooks = await db.select(
    "webhook_events",
    "select=id&ergebnis=eq.fehler&order=verarbeitet_am.desc&limit=20"
  );
  return {
    gesamtKunden: alle.length,
    proStatus: zaehler,
    gebuchtesVolumenCent,
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
