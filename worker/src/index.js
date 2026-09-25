import { supabaseClient, pruefeNutzerToken, holeNutzer } from "./supabase.js";
import { webhookIstEcht, holeAboDetails, kuendigeAbo, erstatteZahlung } from "./paypal.js";
import {
  LEGAL_VERSION,
  calculateProRataRefund,
  createContractNumber,
  declarationConfirmation,
  isValidEmail,
  normalizeEmail,
  sendTextEmail,
  validatePublicDeclaration,
} from "./legal.js";

// Fassung der Gemeinde-/Feuerwehr-Vertragsbedingungen (Organisationen, keine
// Verbraucher iSd § 13 BGB - eigene, einfachere Bedingungen statt der
// Privatkunden-AGB). Entwurf, noch nicht anwaltlich geprueft - siehe
// app/gemeinde-agb.html.
const GEMEINDE_AGB_VERSION = "gemeinde-2026-09-23-entwurf";

// Nur die eigenen Seiten duerfen den Worker aus einem Browser heraus
// aufrufen. Eine fremde Webseite kann damit keine Anfragen im Namen eines
// angemeldeten Kunden stellen. Weitere Adressen (z.B. eine kuenftige Domain)
// kommen ueber die Variable ERLAUBTE_URSPRUENGE dazu, kommagetrennt.
const STANDARD_URSPRUENGE = [
  "https://test.roewise.com",
  "https://roewise.com",
  "https://www.roewise.com",
  "https://foehr.roewise.com",
];

function corsKopfzeilen(request, env) {
  const ursprung = request.headers.get("Origin");
  const erlaubt = new Set([
    ...STANDARD_URSPRUENGE,
    ...String(env.ERLAUBTE_URSPRUENGE || "")
      .split(",")
      .map((eintrag) => eintrag.trim())
      .filter(Boolean),
  ]);
  const kopf = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Passwort",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Ohne passenden Ursprung bleibt der Allow-Origin-Kopf weg; der Browser
  // verwirft die Antwort dann selbst.
  if (ursprung && erlaubt.has(ursprung)) kopf["Access-Control-Allow-Origin"] = ursprung;
  return kopf;
}

function json(daten, status = 200) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

// Setzt die CORS-Kopfzeilen erst auf die fertige Antwort. So bleibt json()
// zustandslos und es kann bei gleichzeitigen Anfragen kein fremder Ursprung
// in eine Antwort geraten.
function mitCors(antwort, request, env) {
  const kopf = new Headers(antwort.headers);
  for (const [name, wert] of Object.entries(corsKopfzeilen(request, env))) {
    kopf.set(name, wert);
  }
  return new Response(antwort.body, { status: antwort.status, headers: kopf });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsKopfzeilen(request, env) });
    }

    return mitCors(await this.route(request, env), request, env);
  },

  async route(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook/paypal" && request.method === "POST") {
        return await verarbeiteWebhook(request, env);
      }
      if (url.pathname === "/api/zugriff" && request.method === "GET") {
        return await pruefeZugriff(request, env);
      }
      if (url.pathname === "/api/stellen" && request.method === "GET") {
        return await geschuetzteStellen(request, env);
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
      if (url.pathname === "/api/geraet-umbenennen" && request.method === "POST") {
        return await kundeBenenntGeraetUm(request, env);
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

// Kennungen aus dem Browser gehoeren nie ungeprueft in einen Datenbankfilter.
const UUID_MUSTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function istUuid(wert) {
  return typeof wert === "string" && UUID_MUSTER.test(wert);
}

// PayPal-Kennungen sind kurz und alphanumerisch (z.B. "I-BW452GLLEP1G").
function istPaypalKennung(wert) {
  return typeof wert === "string" && wert.length <= 64 && /^[A-Za-z0-9._-]+$/.test(wert);
}

// Adresse der oeffentlichen Seiten. Steht in einer Variablen, damit der
// Domainwechsel vor dem Livegang an einer einzigen Stelle passiert.
function basisUrl(env) {
  return String(env.OEFFENTLICHE_BASIS_URL || "https://roewise.com").replace(/\/+$/, "");
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
  const now = new Date().toISOString();

  // Die Erklaerung wird ZUERST gespeichert - vor jeder Verarbeitung. Geht
  // danach etwas schief (PayPal nicht erreichbar, Datenbankfehler bei der
  // Statusaenderung), bleibt der Eingang trotzdem erhalten und wird bestaetigt.
  const declarationText = type === "widerruf"
    ? `Hiermit widerrufe ich den Vertrag ${data.contractReference}.`
    : `Hiermit kündige ich den Vertrag ${data.contractReference} ${data.declarationKind}.`;
  const rows = await db.insert("legal_declarations", [{
    typ: type,
    name: data.name,
    email: data.email,
    vertragsreferenz: data.contractReference,
    vertragsbezeichnung: data.contractLabel,
    erklaerungsart: data.declarationKind,
    grund: data.reason,
    gewuenschtes_ende: data.requestedEnd?.toISOString() || null,
    erklaerungstext: declarationText,
    eingegangen_am: now,
    zugeordnet: false,
    verarbeitungsstatus: "eingegangen",
  }]);
  const declarationId = rows[0].id;

  let subscription = null;
  let customerId = null;
  let effectiveAt = null;
  let processingStatus = "manuelle_pruefung";
  let cancellationRefundCents = 0;
  let refunded = false;

  try {
    const profiles = await db.select(
      "customer_profiles",
      `email=eq.${filterWert(data.email)}&select=id,email`
    );
    if (profiles.length > 0) {
      customerId = profiles[0].id;
      const subscriptions = await db.select(
        "subscriptions",
        `customer_id=eq.${filterWert(customerId)}&select=id,vertragsnummer,paypal_subscription_id,status,bezahlt_bis,mindestlaufzeit_bis,erstellt_am,kuendigungswirksam_am,tariffs(intervall,zielgruppe)`
      );
      // Die Vertragsreferenz muss zu genau dem Konto gehoeren, dessen
      // E-Mail-Adresse angegeben wurde. Sonst bleibt es bei manueller Pruefung.
      subscription = subscriptions.find((entry) =>
        entry.vertragsnummer === data.contractReference || entry.paypal_subscription_id === data.contractReference
      ) || null;
    }
    if (subscription) processingStatus = "zugeordnet";

    if (subscription) {
      const ergebnis = await verarbeiteZugeordneteErklaerung(
        db, env, type, subscription, data.declarationKind, data.requestedEnd, now
      );
      processingStatus = ergebnis.processingStatus;
      effectiveAt = ergebnis.effectiveAt;
      cancellationRefundCents = ergebnis.cancellationRefundCents;
      refunded = ergebnis.refunded;
    }
  } catch (error) {
    // Der Eingang steht bereits in der Datenbank. Die Erklaerung gilt damit
    // als abgegeben; die Folgeverarbeitung uebernimmt der Betreiber.
    console.error("Verarbeitung der Rechtserklaerung fehlgeschlagen", error);
    processingStatus = "verarbeitung_fehlgeschlagen_manuell_pruefen";
  }

  await db.update("legal_declarations", `id=eq.${filterWert(declarationId)}`, {
    subscription_id: subscription?.id || null,
    wirksam_zum: effectiveAt,
    zugeordnet: Boolean(subscription),
    verarbeitungsstatus: processingStatus,
  });

  let confirmation = declarationConfirmation({
    type,
    receiptId: declarationId,
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
  // Auch das Bestaetigen und Verschicken darf die Erklaerung nicht mehr
  // gefaehrden: schlaegt es fehl, bleibt der Eingang gespeichert und die
  // Bestaetigung erscheint trotzdem sofort auf der Webseite.
  try {
    await db.update("legal_declarations", `id=eq.${filterWert(declarationId)}`, { bestaetigt_am: now });
    await nachrichtVormerken(db, env, {
      customerId,
      declarationId,
      to: data.email,
      subject: `${type === "widerruf" ? "Widerruf" : "Kündigung"} – Eingangsbestätigung ${declarationId}`,
      text: confirmation,
    });

    // Der Betreiber wird ebenfalls informiert. Erklaerungen, die nicht
    // automatisch zugeordnet oder erstattet werden konnten, muessen von Hand
    // bearbeitet werden und duerfen nicht unbemerkt liegen bleiben.
    if (env.BETREIBER_EMAIL) {
      await nachrichtVormerken(db, env, {
        declarationId,
        to: env.BETREIBER_EMAIL,
        subject: `Bearbeiten: ${type} ${processingStatus} (${declarationId})`,
        text: `Bearbeitungsstatus: ${processingStatus}\nZugeordnet: ${Boolean(subscription)}\n\n${confirmation}`,
      });
    }
  } catch (error) {
    console.error("Bestaetigung der Rechtserklaerung konnte nicht versandt werden", error);
  }

  return json({
    status: "eingegangen",
    vorgangsnummer: declarationId,
    eingegangen_am: now,
    bestaetigung: confirmation,
  });
}

const SECHS_WOCHEN_MS = 6 * 7 * 24 * 60 * 60 * 1000;
const ZWEI_WOCHEN_MS = 2 * 7 * 24 * 60 * 60 * 1000;

// Gemeinsame Verarbeitung einer einer Vertragsnummer zugeordneten Kuendigung
// oder eines Widerrufs - genutzt vom oeffentlichen Formular UND vom manuellen
// Ausloesen im Admin-Bereich, damit beide Wege exakt dieselben Regeln anwenden.
async function verarbeiteZugeordneteErklaerung(db, env, type, subscription, declarationKind, requestedEnd, now) {
  const istOrganisation = subscription.tariffs?.zielgruppe === "organisation";

  if (type === "kuendigung") {
    const result = await kuendigungVerarbeiten(db, env, subscription, requestedEnd, declarationKind);
    return {
      processingStatus: result.processingStatus,
      effectiveAt: result.effectiveAt,
      cancellationRefundCents: result.refundedCents,
      refunded: false,
    };
  }

  // Organisationen (Gemeinden/Feuerwehren) sind keine Verbraucher (§ 13 BGB) -
  // fuer sie besteht kein gesetzliches Widerrufsrecht (Gemeinde-AGB Ziffer 6).
  if (istOrganisation) {
    return { processingStatus: "kein_widerrufsrecht_organisation", effectiveAt: null, cancellationRefundCents: 0, refunded: false };
  }

  let processingStatus = "zugeordnet";
  let effectiveAt = null;
  let refunded = false;

  // Das gesetzliche Widerrufsrecht besteht vierzehn Tage ab Vertragsschluss
  // (§ 355 BGB). Danach automatisch zu erstatten waere falsch - der Anbieter
  // ist dazu nicht mehr verpflichtet. Nach Fristablauf daher keine
  // automatische Erstattung/PayPal-Kuendigung, sondern manuelle Pruefung
  // (der Betreiber kann eine spaete Erklaerung z.B. als Kulanz annehmen).
  const widerrufsfristAbgelaufen = subscription.erstellt_am &&
    new Date(now).getTime() - new Date(subscription.erstellt_am).getTime() > 14 * 24 * 60 * 60 * 1000;
  if (widerrufsfristAbgelaufen) {
    return { processingStatus: "widerrufsfrist_abgelaufen", effectiveAt: null, cancellationRefundCents: 0, refunded: false };
  }

  if (subscription.paypal_subscription_id && !["abgelaufen", "widerrufen", "erstattet"].includes(subscription.status)) {
    const cancelled = await kuendigeAbo(env, subscription.paypal_subscription_id, "Widerruf durch Kunden");
    if (!cancelled) processingStatus = "paypal_pruefung_noetig";
  }

  if (["erstattet", "widerrufen"].includes(subscription.status)) {
    // Bereits erledigt (z.B. Doppel-Einreichung) - nichts erneut
    // ueberschreiben, insbesondere "erstattet" nicht faelschlich
    // wieder auf "widerrufen" zuruecksetzen.
    processingStatus = "vertrag_bereits_beendet";
    effectiveAt = subscription.kuendigungswirksam_am || now;
    return { processingStatus, effectiveAt, cancellationRefundCents: 0, refunded: false };
  }

  const payments = await db.select(
    "payments",
    `subscription_id=eq.${filterWert(subscription.id)}&status=eq.erfolgreich&select=id,paypal_capture_id,betrag_cent&order=zeitpunkt.desc&limit=1`
  );
  if (payments.length > 0 && payments[0].paypal_capture_id) {
    try {
      await erstatteZahlung(env, payments[0].paypal_capture_id);
      await db.update("payments", `id=eq.${filterWert(payments[0].id)}`, {
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
  effectiveAt = now;
  await db.update("subscriptions", `id=eq.${filterWert(subscription.id)}`, {
    status: refunded ? "erstattet" : "widerrufen",
    gekuendigt_am: now,
    kuendigungswirksam_am: now,
    aktualisiert_am: now,
  });
  return { processingStatus, effectiveAt, cancellationRefundCents: 0, refunded };
}

async function kuendigungVerarbeiten(db, env, subscription, requestedEnd = null, declarationKind = "ordentlich") {
  // Ein bereits beendeter Vertrag (erstattet/widerrufen/abgelaufen) darf durch
  // eine nachtraeglich eingehende Kuendigung nicht wieder auf "gekuendigt,
  // laeuft bis Vertragsende" zurueckgesetzt werden - sonst wirkt ein schon
  // erstatteter Vertrag faelschlich wieder aktiv.
  if (["erstattet", "widerrufen", "abgelaufen"].includes(subscription.status)) {
    return {
      effectiveAt: subscription.kuendigungswirksam_am || subscription.bezahlt_bis || new Date().toISOString(),
      processingStatus: "vertrag_bereits_beendet",
      refundedCents: 0,
    };
  }
  const now = new Date();
  // Organisationen (Gemeinden/Feuerwehren) haben eine eigene, monatliche
  // Laufzeit und eine kuerzere Kuendigungsfrist als Privatkunden - siehe
  // Gemeinde-AGB Ziffer 5 (1 Monat Mindestlaufzeit, 2 Wochen Frist zum
  // Monatsende) statt Ziffer 5 der Privatkunden-AGB (12 Monate, 6 Wochen).
  const istOrganisation = subscription.tariffs?.zielgruppe === "organisation";
  const periodenMonate = subscription.tariffs?.intervall === "monatlich" ? 1 : 12;
  const vorlaufMs = istOrganisation ? ZWEI_WOCHEN_MS : SECHS_WOCHEN_MS;
  const minimumEnd = subscription.mindestlaufzeit_bis
    ? new Date(subscription.mindestlaufzeit_bis)
    : new Date(subscription.bezahlt_bis || now);
  const paidUntil = new Date(subscription.bezahlt_bis || minimumEnd);

  let effective;
  const refundEligible = declarationKind === "ausserordentlich";
  if (refundEligible) {
    // Ausserordentliche Kuendigung aus wichtigem Grund wirkt sofort,
    // unabhaengig von Mindestlaufzeit und Kuendigungsfrist.
    effective = now;
    if (requestedEnd && requestedEnd > effective && requestedEnd < paidUntil) effective = requestedEnd;
  } else {
    // Ordentliche Kuendigung wirkt erst zum Ende der laufenden Laufzeit,
    // fruehestens zum Ende der Mindestlaufzeit. Liegt zwischen jetzt und
    // diesem Zeitpunkt weniger Vorlauf als die Kuendigungsfrist, verlaengert
    // sich der Vertrag noch um eine weitere Periode (naechster Termin).
    let naechstesEnde = paidUntil < minimumEnd ? minimumEnd : paidUntil;
    while (naechstesEnde.getTime() - now.getTime() < vorlaufMs) {
      const weiter = new Date(naechstesEnde);
      weiter.setUTCMonth(weiter.getUTCMonth() + periodenMonate);
      naechstesEnde = weiter;
    }
    effective = naechstesEnde;
    // Ein spaeterer Wunschtermin ist immer zulaessig, ein frueherer nicht.
    if (requestedEnd && requestedEnd > effective) effective = requestedEnd;
  }

  let processingStatus = "zugeordnet";
  let refundedCents = 0;
  if (subscription.paypal_subscription_id && !["abgelaufen", "widerrufen", "erstattet"].includes(subscription.status)) {
    const cancelled = await kuendigeAbo(env, subscription.paypal_subscription_id, "Kündigung durch Kunden");
    if (!cancelled) processingStatus = "paypal_pruefung_noetig";
  }

  // Nur bei ausserordentlicher Kuendigung endet der Vertrag vor dem
  // Laufzeitende; dafuer wird die bereits gezahlte, ungenutzte Restzeit
  // anteilig erstattet. Eine ordentliche Kuendigung wirkt erst zum
  // Laufzeitende, dafuer entfaellt eine anteilige Erstattung.
  if (refundEligible && effective < paidUntil) {
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
      await db.update("subscriptions", `paypal_subscription_id=eq.${filterWert(resource.id)}`, {
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
      await db.update("subscriptions", `id=eq.${filterWert(abo.id)}`, {
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
        `paypal_subscription_id=eq.${filterWert(resource.id)}&select=id`
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
      await db.update("subscriptions", `paypal_subscription_id=eq.${filterWert(resource.id)}`, {
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
        `paypal_subscription_id=eq.${filterWert(resource.id)}&select=id,bezahlt_bis`
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
        `paypal_capture_id=eq.${filterWert(urspruenglicheSaleId)}`,
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
const STANDARD_MAX_GERAETE = 2;

// Zentrale Entscheidung "darf dieses Geraet dieses Konto nutzen?". Sie wird
// sowohl von /api/zugriff als auch vor der Auslieferung der Stellendaten
// verwendet, damit beide Wege nie auseinanderlaufen koennen.
async function entscheideZugriff(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const geraetId = new URL(request.url).searchParams.get("geraet");

  // Die Geraetekennung wird auf dem Geraet erzeugt und landet in der
  // Datenbank; sie muss deshalb ein eng begrenztes Format haben.
  if (!accessToken || !istUuid(geraetId)) {
    return { erlaubt: false, grund: "fehlende_angaben", status: 400 };
  }

  // Der Nutzer wird ueber sein Token identifiziert; die Betreibereigenschaft
  // entscheidet ausschliesslich der Server anhand einer Liste im Worker.
  const nutzer = await holeNutzer(env, accessToken);
  if (!nutzer) {
    return { erlaubt: false, grund: "nicht_angemeldet", status: 401 };
  }
  const authUserId = nutzer.id;
  const betreiber = istBetreiber(env, nutzer.email);

  // Der Betrieb selbst hat kein Kundenabo. Betreiberkonten werden deshalb
  // unabhaengig vom Vertragsstatus freigegeben - die Berechtigung kommt
  // allein aus der serverseitigen Liste, nicht aus dem Browser.
  if (betreiber) {
    return { erlaubt: true, status: "betreiber", betreiber: true, maxGeraete: null };
  }

  const db = supabaseClient(env);

  let profile = await db.select(
    "customer_profiles",
    `auth_user_id=eq.${filterWert(authUserId)}&select=id`
  );
  if (profile.length === 0) {
    // Kein per Anmeldung verknuepftes Profil gefunden. Das kommt vor, wenn
    // der Betrieb einen Zugang manuell angelegt hat (z.B. Feuerwehr/Gemeinde
    // nach Ueberweisung, ohne PayPal) - dort ist zu diesem Zeitpunkt nur die
    // E-Mail-Adresse bekannt, noch keine Supabase-Nutzer-ID. Beim ersten
    // Login wird das per E-Mail-Adresse gefundene, noch unverknuepfte Profil
    // jetzt fest mit dieser Anmeldung verknuepft.
    const unverknuepft = await db.select(
      "customer_profiles",
      `email=eq.${filterWert(nutzer.email)}&auth_user_id=is.null&select=id`
    );
    if (unverknuepft.length > 0) {
      await db.update("customer_profiles", `id=eq.${filterWert(unverknuepft[0].id)}`, {
        auth_user_id: authUserId,
      });
      profile = unverknuepft;
    }
  }
  if (profile.length === 0) return { erlaubt: false, grund: "kein_profil", betreiber };
  const customerId = profile[0].id;

  const abos = await db.select(
    "subscriptions",
    `customer_id=eq.${filterWert(customerId)}&select=id,status,manuell_gesperrt,bezahlt_bis,kuendigungswirksam_am,tariffs(max_geraete)&order=erstellt_am.desc&limit=1`
  );
  if (abos.length === 0) return { erlaubt: false, grund: "kein_abo" };
  const abo = abos[0];

  if (abo.manuell_gesperrt) return { erlaubt: false, grund: "manuell_gesperrt" };
  if (!ERLAUBTE_STATUS.has(abo.status)) {
    return { erlaubt: false, grund: "abo_status_" + abo.status };
  }
  // Ohne bekanntes Vertragsende darf ein gekuendigter Vertrag keinen
  // unbegrenzten Zugang ergeben.
  if (abo.status === "gekuendigt_zum_ende" && !abo.bezahlt_bis) {
    return { erlaubt: false, grund: "vertragsende_ungeklaert" };
  }
  if (abo.kuendigungswirksam_am && new Date(abo.kuendigungswirksam_am) <= new Date()) {
    return { erlaubt: false, grund: "kuendigung_wirksam" };
  }
  if (abo.bezahlt_bis && new Date(abo.bezahlt_bis) < new Date()) {
    return { erlaubt: false, grund: "bezahlter_zeitraum_beendet" };
  }

  // Geraet registrieren/aktualisieren, Geraetelimit aus dem gebuchten Tarif.
  const maxGeraete = abo.tariffs?.max_geraete ?? STANDARD_MAX_GERAETE;
  const geraete = await db.select(
    "devices",
    `customer_id=eq.${filterWert(customerId)}&select=id,geraet_kennung`
  );
  const bekannt = geraete.find((g) => g.geraet_kennung === geraetId);
  if (!bekannt) {
    if (geraete.length >= maxGeraete) {
      return { erlaubt: false, grund: "geraetelimit_erreicht", maxGeraete };
    }
    await db.insert("devices", [{ customer_id: customerId, geraet_kennung: geraetId, bestaetigt: true }]);
  } else {
    await db.update("devices", `id=eq.${filterWert(bekannt.id)}`, {
      zuletzt_aktiv: new Date().toISOString(),
    });
  }

  return {
    erlaubt: true,
    status: abo.status,
    maxGeraete,
    bezahltBis: abo.bezahlt_bis,
    betreiber,
  };
}

// Betreiberkonten fuer die internen Bereiche (Datenpflege, nutzer-admin).
// Die Liste steht nur im Worker, nie im Browsercode.
function istBetreiber(env, email) {
  const erlaubte = String(env.BETREIBER_AUTH_EMAILS || "")
    .split(",")
    .map((eintrag) => eintrag.trim().toLowerCase())
    .filter(Boolean);
  return erlaubte.includes(String(email || "").trim().toLowerCase());
}

async function pruefeZugriff(request, env) {
  const ergebnis = await entscheideZugriff(request, env);
  const { status = 200, ...rest } = ergebnis;
  return json(rest, ergebnis.erlaubt ? 200 : status);
}

// Liefert die Stellendaten nur an berechtigte Konten aus. Damit haengt der
// Schutz nicht mehr allein an einer Sperrschicht im Browser.
// WICHTIG: Das wirkt erst, wenn die Datei nicht zusaetzlich oeffentlich als
// statische Datei erreichbar ist (siehe Abschlussbericht).
async function geschuetzteStellen(request, env) {
  const ergebnis = await entscheideZugriff(request, env);
  if (!ergebnis.erlaubt) {
    const { status = 403, ...rest } = ergebnis;
    return json(rest, status === 200 ? 403 : status);
  }

  const quelle = env.STELLEN_QUELLE_URL;
  if (!quelle) return json({ fehler: "stellenquelle_nicht_konfiguriert" }, 503);

  const antwort = await fetch(quelle, {
    headers: env.STELLEN_QUELLE_TOKEN
      ? { Authorization: "Bearer " + env.STELLEN_QUELLE_TOKEN }
      : {},
    cf: { cacheTtl: 300 },
  });
  if (!antwort.ok) return json({ fehler: "stellen_nicht_verfuegbar" }, 502);

  return new Response(antwort.body, {
    status: 200,
    headers: {
      "Content-Type": "application/geo+json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      // Kurz zwischenspeichern, aber nur privat: nach Vertragsende soll keine
      // dauerhaft nutzbare Kopie im Zwischenspeicher zurueckbleiben.
      "Cache-Control": "private, max-age=300",
    },
  });
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
  if (
    !istPaypalKennung(paypal_subscription_id) ||
    typeof tariff_code !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(tariff_code) ||
    body.agb_akzeptiert !== true ||
    typeof body.sofortiger_beginn !== "boolean"
  ) {
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
    `customer_id=eq.${filterWert(customerId)}&status=in.(wird_geprueft,wartet_auf_leistungsbeginn,aktiv,kulanzzeit,gekuendigt_zum_ende)&select=id&limit=1`
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
    "Danach verlängert sich der Vertrag um jeweils weitere zwölf Monate, sofern er nicht mit einer Frist von sechs Wochen zum Ende der jeweiligen Laufzeit gekündigt wird. Die Vergütung von 12,00 EUR wird jeweils für zwölf Monate im Voraus berechnet. Für eine ordentliche Kündigung erfolgt keine anteilige Erstattung; das Recht zur außerordentlichen Kündigung aus wichtigem Grund bleibt unberührt.",
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
    `Kündigung: im Kundenbereich oder ohne Anmeldung unter ${basisUrl(env)}/kuendigen.html.`,
    "",
    "Widerrufsbelehrung",
    `Sie können den Vertrag binnen vierzehn Tagen ab Vertragsschluss ohne Angabe von Gründen widerrufen. Senden Sie dazu eine eindeutige Erklärung an den Anbieter oder nutzen Sie ${basisUrl(env)}/widerruf.html. Zur Fristwahrung genügt die rechtzeitige Absendung. Nach Widerruf werden erhaltene Zahlungen unverzüglich und spätestens binnen vierzehn Tagen mit demselben Zahlungsmittel zurückgezahlt. Bei ausdrücklich verlangtem vorzeitigem Leistungsbeginn kann Wertersatz für die bis zum Widerruf erbrachte Leistung anfallen.`,
    "Muster: Hiermit widerrufe ich den von mir abgeschlossenen Vertrag über den Löschbärt Föhr Jahreszugang. Name, Anschrift, Bestelldatum, Datum.",
    "",
    `Vereinbarte AGB (Fassung ${LEGAL_VERSION}): Der Zugang ist persönlich und auf zwei registrierte Geräte begrenzt. Zugangsdaten dürfen nicht an Dritte weitergegeben werden. Die Mindestlaufzeit beträgt zwölf Monate ab Leistungsbeginn. Danach verlängert sich der Vertrag um jeweils weitere zwölf Monate, sofern er nicht mit einer Frist von sechs Wochen zum Ende der jeweiligen Laufzeit gekündigt wird; für eine ordentliche Kündigung erfolgt keine anteilige Erstattung. Das Recht zur außerordentlichen Kündigung aus wichtigem Grund bleibt unberührt. Erforderliche Aktualisierungen einschließlich Sicherheitsaktualisierungen werden während des Bereitstellungszeitraums bereitgestellt. Es gelten die gesetzlichen Mängelrechte. Der Anbieter haftet unbeschränkt für Vorsatz, grobe Fahrlässigkeit, Schäden an Leben, Körper oder Gesundheit, nach dem Produkthaftungsgesetz und im Umfang übernommener Garantien. Bei leicht fahrlässiger Verletzung wesentlicher Vertragspflichten ist die Haftung auf den typischen vorhersehbaren Schaden begrenzt; im Übrigen ist sie, soweit gesetzlich zulässig, ausgeschlossen. Deutsches Recht gilt unter Wahrung zwingender Verbraucherschutzvorschriften. Der Anbieter nimmt nicht an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teil.`,
    `Zusätzliche lesbare Fassung: ${basisUrl(env)}/agb.html`,
    `Datenschutz: ${basisUrl(env)}/datenschutz.html`,
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
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${filterWert(authUserId)}&select=id,email`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  const abos = await db.select(
    "subscriptions",
    `customer_id=eq.${filterWert(profile[0].id)}&status=in.(wird_geprueft,aktiv,kulanzzeit,wartet_auf_leistungsbeginn)&select=id,status,paypal_subscription_id,bezahlt_bis,mindestlaufzeit_bis,vertragsnummer,tariffs(bezeichnung)&limit=1`
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
  if (!istUuid(body.device_id)) return json({ fehler: "fehlende_angaben" }, 400);

  const db = supabaseClient(env);
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${filterWert(authUserId)}&select=id`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  // Nur loeschen, wenn das Geraet wirklich diesem Kunden gehoert (sonst
  // koennte ein Kunde ueber eine geratene ID fremde Geraete entfernen).
  const geraete = await db.select(
    "devices",
    `id=eq.${filterWert(body.device_id)}&customer_id=eq.${filterWert(profile[0].id)}&select=id`
  );
  if (geraete.length === 0) return json({ fehler: "geraet_nicht_gefunden" }, 404);

  await db.delete("devices", `id=eq.${filterWert(body.device_id)}`);
  return json({ status: "entfernt" });
}

// ---------- Geraet durch Kunden umbenennen ----------
// Erlaubt Kunden, Geraete-Eintraege (die als UUID gespeichert werden) mit
// einem erkennbaren Namen zu versehen, z.B. um zwischen Browsern auf
// demselben physischen Geraet zu unterscheiden.

async function kundeBenenntGeraetUm(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const authUserId = await pruefeNutzerToken(env, accessToken);
  if (!authUserId) return json({ fehler: "nicht_angemeldet" }, 401);

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!istUuid(body.device_id) || !name) return json({ fehler: "fehlende_angaben" }, 400);

  const db = supabaseClient(env);
  const profile = await db.select("customer_profiles", `auth_user_id=eq.${filterWert(authUserId)}&select=id`);
  if (profile.length === 0) return json({ fehler: "kein_profil" }, 404);

  const geraete = await db.select(
    "devices",
    `id=eq.${filterWert(body.device_id)}&customer_id=eq.${filterWert(profile[0].id)}&select=id`
  );
  if (geraete.length === 0) return json({ fehler: "geraet_nicht_gefunden" }, 404);

  await db.update("devices", `id=eq.${filterWert(body.device_id)}`, { geraet_name: name });
  return json({ status: "umbenannt" });
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
        await db.update("subscriptions", `id=eq.${filterWert(abo.id)}`, {
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
    await db.update("subscriptions", `id=eq.${filterWert(abo.id)}`, {
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
      "select=id,customer_id,vertragsnummer,status,beginn,erstellt_am,naechste_zahlung,bezahlt_bis,gekuendigt_am,kuendigungswirksam_am,manuell_gesperrt,notiz,paypal_subscription_id,customer_profiles(email),tariffs(bezeichnung,preis_cent,intervall,zielgruppe),payments(status,betrag_cent,zeitpunkt,paypal_capture_id)&order=erstellt_am.desc&payments.order=zeitpunkt.desc"
    );
    return json(kunden);
  }
  if (pfad === "/api/admin/erklaerungen" && request.method === "GET") {
    const erklaerungen = await db.select(
      "legal_declarations",
      "select=id,typ,vertragsreferenz,email,eingegangen_am,verarbeitungsstatus,zugeordnet,wirksam_zum&order=eingegangen_am.desc&limit=50"
    );
    return json(erklaerungen);
  }
  if (pfad === "/api/admin/sperren" && request.method === "POST") {
    return await adminAktion(request, env, db, "sperren", { manuell_gesperrt: true });
  }
  if (pfad === "/api/admin/entsperren" && request.method === "POST") {
    return await adminAktion(request, env, db, "entsperren", { manuell_gesperrt: false });
  }
  if (pfad === "/api/admin/bearbeiten" && request.method === "POST") {
    return await adminBearbeiten(request, env, db);
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
  if (pfad === "/api/admin/manuell-anlegen" && request.method === "POST") {
    return await adminManuellAnlegen(request, env, db);
  }
  if (pfad === "/api/admin/geraete-zuruecksetzen" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!istUuid(body.customer_id)) return json({ fehler: "fehlende_angaben" }, 400);
    return await adminGeraeteZuruecksetzen(env, db, body.customer_id);
  }
  if (pfad === "/api/admin/erklaerung-ausloesen" && request.method === "POST") {
    return await adminErklaerungAusloesen(request, env, db);
  }
  if (pfad === "/api/admin/loeschen" && request.method === "POST") {
    return await adminLoeschen(request, env, db);
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
  if (!istUuid(body.subscription_id)) return json({ fehler: "fehlende_angaben" }, 400);

  await db.update("subscriptions", `id=eq.${filterWert(body.subscription_id)}`, {
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

// Nachtraegliches Bearbeiten eines bestehenden Vertrags: Notiz und/oder
// Bezahlt-bis-Datum aendern. Nur die tatsaechlich mitgeschickten Felder
// werden angefasst, damit ein leer gelassenes Feld nichts loescht.
async function adminBearbeiten(request, env, db) {
  const body = await request.json().catch(() => ({}));
  if (!istUuid(body.subscription_id)) return json({ fehler: "fehlende_angaben" }, 400);

  const patch = {};
  if (typeof body.notiz === "string") patch.notiz = body.notiz.slice(0, 500) || null;
  if (typeof body.bezahlt_bis === "string" && body.bezahlt_bis) {
    const datum = new Date(body.bezahlt_bis);
    if (Number.isNaN(datum.getTime())) return json({ fehler: "ungueltiges_datum" }, 400);
    patch.bezahlt_bis = datum.toISOString();
  }
  if (Object.keys(patch).length === 0) return json({ fehler: "nichts_zu_aendern" }, 400);

  await db.update("subscriptions", `id=eq.${filterWert(body.subscription_id)}`, {
    ...patch,
    aktualisiert_am: new Date().toISOString(),
  });
  await db.insert("admin_actions", [
    {
      admin_name: "Joerg",
      aktion: "bearbeitet",
      subscription_id: body.subscription_id,
      details: JSON.stringify(patch),
    },
  ]);
  return json({ status: "ok" });
}

async function adminGeraeteZuruecksetzen(env, db, customerId) {
  // Loeschen statt nur markieren, damit sofort wieder neue Geraete moeglich sind.
  await db.delete("devices", `customer_id=eq.${filterWert(customerId)}`);
  await db.insert("admin_actions", [
    { admin_name: "Joerg", aktion: "geraete_zurueckgesetzt", customer_id: customerId },
  ]);
  return json({ status: "ok" });
}

// Manuell einen Zugang anlegen (Zahlung per Ueberweisung/Rechnung statt
// PayPal - z.B. Feuerwehr oder Gemeinde). Legt bei Bedarf ein noch nicht mit
// einer Anmeldung verknuepftes Kundenprofil an; die Verknuepfung mit der
// echten Supabase-Anmeldung passiert automatisch beim ersten Login der
// Kundin/des Kunden (siehe entscheideZugriff).
async function adminManuellAnlegen(request, env, db) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const tariffCode = String(body.tariff_code || "");
  if (
    !isValidEmail(email) ||
    !/^[a-z0-9-]{1,40}$/.test(tariffCode)
  ) {
    return json({ fehler: "fehlende_oder_ungueltige_angaben" }, 400);
  }

  const tarife = await db.select(
    "tariffs",
    `code=eq.${filterWert(tariffCode)}&aktiv=eq.true&select=id,bezeichnung,intervall,zielgruppe`
  );
  if (tarife.length === 0) return json({ fehler: "unbekannter_tarif" }, 400);
  // Organisationen (Gemeinden/Feuerwehren) sind keine Verbraucher (§ 13 BGB):
  // das gesetzliche Widerrufsrecht und die Verbraucher-Kuendigungsregeln der
  // Privatkunden-AGB gelten fuer sie nicht automatisch. Fuer diese Vertraege
  // gilt bis zu einer individuellen Vereinbarung der eigene Gemeinde-Entwurf.
  const istOrganisation = tarife[0].zielgruppe === "organisation";

  let profile = await db.select("customer_profiles", `email=eq.${filterWert(email)}&select=id,auth_user_id`);
  let customerId;
  if (profile.length === 0) {
    const neu = await db.insert("customer_profiles", [{ email }]);
    customerId = neu[0].id;
  } else {
    customerId = profile[0].id;
  }

  // Ein zweiter Vertrag auf dasselbe Konto wird nicht angelegt, damit hier
  // nicht aus Versehen Doppelbuchungen entstehen.
  const bestehend = await db.select(
    "subscriptions",
    `customer_id=eq.${filterWert(customerId)}&status=in.(wird_geprueft,wartet_auf_leistungsbeginn,aktiv,kulanzzeit,gekuendigt_zum_ende)&select=id&limit=1`
  );
  if (bestehend.length > 0) return json({ fehler: "jahreszugang_bereits_vorhanden" }, 409);

  const now = new Date();
  const performanceStart = body.leistungsbeginn ? new Date(body.leistungsbeginn) : now;
  if (Number.isNaN(performanceStart.getTime())) return json({ fehler: "ungueltiges_datum" }, 400);
  // Laufzeit richtet sich nach dem Abrechnungsintervall des Tarifs -
  // 'monatlich' bedeutet einen Monat, alles andere weiterhin zwoelf Monate.
  const periodenMonate = tarife[0].intervall === "monatlich" ? 1 : 12;
  const contractEnd = new Date(performanceStart);
  contractEnd.setUTCMonth(contractEnd.getUTCMonth() + periodenMonate);
  const contractNumber = createContractNumber(now);
  const zahlungsreferenz = String(body.zahlungsreferenz || "").slice(0, 300) || null;

  await db.insert("subscriptions", [
    {
      customer_id: customerId,
      tariff_id: tarife[0].id,
      status: performanceStart <= now ? "aktiv" : "wartet_auf_leistungsbeginn",
      paypal_subscription_id: null,
      vertragsnummer: contractNumber,
      sofortiger_beginn: performanceStart <= now,
      leistungsbeginn_am: performanceStart.toISOString(),
      mindestlaufzeit_bis: contractEnd.toISOString(),
      bezahlt_bis: contractEnd.toISOString(),
      agb_version: istOrganisation ? GEMEINDE_AGB_VERSION : LEGAL_VERSION,
      widerruf_version: istOrganisation ? null : LEGAL_VERSION,
      datenschutz_version: LEGAL_VERSION,
      notiz: zahlungsreferenz ? `Manuell angelegt (Zahlung außerhalb PayPal): ${zahlungsreferenz}` : "Manuell angelegt (Zahlung außerhalb PayPal)",
    },
  ]);

  await db.insert("admin_actions", [
    { admin_name: "Joerg", aktion: "manuell_angelegt", customer_id: customerId, details: `${tariffCode} / ${zahlungsreferenz || "ohne Referenz"}` },
  ]);

  const confirmation = [
    "Vertragsbestätigung – Löschbärt",
    "",
    `Vertragsnummer: ${contractNumber}`,
    `Tarif: ${tarife[0].bezeichnung}`,
    `Leistungsbeginn: ${performanceStart.toISOString()}`,
    `Laufzeit bis: ${contractEnd.toISOString()}`,
    "Die Zahlung wurde außerhalb von PayPal (z.B. per Überweisung/Rechnung) erhalten und manuell verbucht.",
    istOrganisation
      ? `Es gelten die Vertragsbedingungen für Gemeinden/Feuerwehren: ${basisUrl(env)}/gemeinde-agb.html`
      : `Es gelten die AGB: ${basisUrl(env)}/agb.html`,
    "",
    "Zugang: Bitte auf der Nutzerseite mit dieser E-Mail-Adresse anmelden (Anmelde-Link per E-Mail).",
    "Kontakt: wasserentnahme-foehr@web.de",
  ].join("\n");
  await nachrichtVormerken(db, env, {
    customerId,
    to: email,
    subject: `Vertragsbestätigung ${contractNumber}`,
    text: confirmation,
  });

  return json({ status: "angelegt", vertragsnummer: contractNumber, leistungsbeginn_am: performanceStart.toISOString() });
}

// Kuendigung oder Widerruf manuell im Admin-Bereich ausloesen - z.B. wenn
// eine Gemeinde/Feuerwehr telefonisch oder per E-Mail (statt ueber das
// oeffentliche Formular) kuendigt. Nutzt exakt dieselbe Verarbeitung wie das
// oeffentliche Formular (verarbeiteZugeordneteErklaerung), damit dieselben
// Regeln gelten (Mindestlaufzeit, Kuendigungsfrist, 14-Tage-Widerrufsfrist,
// kein Widerrufsrecht fuer Organisationen).
async function adminErklaerungAusloesen(request, env, db) {
  const body = await request.json().catch(() => ({}));
  const type = body.typ === "widerruf" ? "widerruf" : body.typ === "kuendigung" ? "kuendigung" : null;
  if (!istUuid(body.subscription_id) || !type) return json({ fehler: "fehlende_angaben" }, 400);
  const declarationKind = body.erklaerungsart === "ausserordentlich" ? "ausserordentlich" : "ordentlich";
  let requestedEnd = null;
  if (typeof body.gewuenschtes_ende === "string" && body.gewuenschtes_ende) {
    requestedEnd = new Date(body.gewuenschtes_ende);
    if (Number.isNaN(requestedEnd.getTime())) return json({ fehler: "ungueltiges_datum" }, 400);
  }

  const treffer = await db.select(
    "subscriptions",
    `id=eq.${filterWert(body.subscription_id)}&select=id,vertragsnummer,paypal_subscription_id,status,bezahlt_bis,mindestlaufzeit_bis,erstellt_am,kuendigungswirksam_am,customer_id,tariffs(intervall,zielgruppe),customer_profiles(email)`
  );
  if (treffer.length === 0) return json({ fehler: "unbekannter_vertrag" }, 404);
  const subscription = treffer[0];
  const email = subscription.customer_profiles?.email || null;
  const now = new Date().toISOString();

  const rows = await db.insert("legal_declarations", [{
    typ: type,
    name: "Admin-Bereich",
    email,
    vertragsreferenz: subscription.vertragsnummer || subscription.id,
    erklaerungsart: declarationKind,
    grund: String(body.grund || "").slice(0, 500) || "Manuell im Admin-Bereich ausgelöst",
    gewuenschtes_ende: requestedEnd?.toISOString() || null,
    eingegangen_am: now,
    zugeordnet: true,
    subscription_id: subscription.id,
    verarbeitungsstatus: "eingegangen",
  }]);
  const declarationId = rows[0].id;

  const ergebnis = await verarbeiteZugeordneteErklaerung(db, env, type, subscription, declarationKind, requestedEnd, now);

  await db.update("legal_declarations", `id=eq.${filterWert(declarationId)}`, {
    wirksam_zum: ergebnis.effectiveAt,
    verarbeitungsstatus: ergebnis.processingStatus,
    bestaetigt_am: now,
  });
  await db.insert("admin_actions", [
    {
      admin_name: "Joerg",
      aktion: type === "widerruf" ? "widerruf_ausgeloest" : "kuendigung_ausgeloest",
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      details: ergebnis.processingStatus,
    },
  ]);

  if (email) {
    const text = type === "widerruf"
      ? `Der Widerruf zu Vertrag ${subscription.vertragsnummer || subscription.id} wurde im Admin-Bereich erfasst. Bearbeitungsstatus: ${ergebnis.processingStatus}.`
      : `Die Kündigung zu Vertrag ${subscription.vertragsnummer || subscription.id} wurde im Admin-Bereich erfasst. Bearbeitungsstatus: ${ergebnis.processingStatus}${ergebnis.effectiveAt ? `, wirksam zum ${ergebnis.effectiveAt}` : ""}.`;
    await nachrichtVormerken(db, env, {
      customerId: subscription.customer_id,
      declarationId,
      to: email,
      subject: `${type === "widerruf" ? "Widerruf" : "Kündigung"} erfasst – ${subscription.vertragsnummer || subscription.id}`,
      text,
    });
  }

  return json({ status: "ok", verarbeitungsstatus: ergebnis.processingStatus, wirksam_zum: ergebnis.effectiveAt });
}

// Endgueltiges Loeschen eines Vertrags (z.B. auf Wunsch der Kundin/des
// Kunden, Art. 17 DSGVO, oder ein aus Versehen angelegter Testeintrag).
// Loescht nur die Vertragszeile selbst - Zahlungen, Rechnungen,
// Vertragsannahmen und Kuendigungen dieses Vertrags werden durch die
// Datenbank per ON DELETE CASCADE automatisch mitentfernt. Das
// Kundenprofil (E-Mail-Adresse) bleibt bestehen, falls weitere Vertraege
// oder eine spaetere Neuanlage darauf verweisen.
async function adminLoeschen(request, env, db) {
  const body = await request.json().catch(() => ({}));
  if (!istUuid(body.subscription_id)) return json({ fehler: "fehlende_angaben" }, 400);

  const treffer = await db.select(
    "subscriptions",
    `id=eq.${filterWert(body.subscription_id)}&select=id,vertragsnummer,customer_id,customer_profiles(email)`
  );
  if (treffer.length === 0) return json({ fehler: "unbekannter_vertrag" }, 404);
  const subscription = treffer[0];

  await db.insert("admin_actions", [
    {
      admin_name: "Joerg",
      aktion: "vertrag_geloescht",
      customer_id: subscription.customer_id,
      details: `${subscription.vertragsnummer || subscription.id} / ${subscription.customer_profiles?.email || "ohne E-Mail"}`,
    },
  ]);
  await db.delete("subscriptions", `id=eq.${filterWert(body.subscription_id)}`);

  return json({ status: "geloescht" });
}
