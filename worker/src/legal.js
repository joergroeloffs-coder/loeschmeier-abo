export const LEGAL_VERSION = "2026-09-21";

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function cleanText(value, maxLength = 500) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

export function validatePublicDeclaration(body, type) {
  const name = cleanText(body.name, 160);
  const email = normalizeEmail(body.email);
  const contractReference = cleanText(body.vertragsreferenz, 160);
  const contractLabel = cleanText(body.vertragsbezeichnung || "Löschmeier Föhr – Jahreszugang", 200);
  if (!name || !isValidEmail(email) || !contractReference || !contractLabel) {
    return { ok: false, error: "ungueltige_oder_fehlende_angaben" };
  }
  if (type === "kuendigung" && !["ordentlich", "ausserordentlich"].includes(body.erklaerungsart)) {
    return { ok: false, error: "ungueltige_kuendigungsart" };
  }
  const requestedEnd = body.gewuenschtes_ende ? new Date(body.gewuenschtes_ende) : null;
  if (requestedEnd && Number.isNaN(requestedEnd.getTime())) {
    return { ok: false, error: "ungueltiges_wunschdatum" };
  }
  return {
    ok: true,
    value: {
      name,
      email,
      contractReference,
      contractLabel,
      declarationKind: type === "kuendigung" ? body.erklaerungsart : null,
      reason: cleanText(body.grund, 1000) || null,
      requestedEnd,
    },
  };
}

export function createContractNumber(now = new Date(), random = crypto.randomUUID()) {
  const year = now.getUTCFullYear();
  return `LM-${year}-${String(random).replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export function calculateProRataRefund({ amountCents, periodStart, periodEnd, effectiveAt }) {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const effective = new Date(effectiveAt).getTime();
  if (![start, end, effective].every(Number.isFinite) || end <= start || amountCents <= 0) return 0;
  const unused = Math.max(0, end - Math.max(start, effective));
  return Math.min(amountCents, Math.round(amountCents * unused / (end - start)));
}

export async function sendTextEmail(env, { to, subject, text, idempotencyKey }) {
  if (!env.RESEND_API_KEY || !env.TRANSACTIONAL_FROM) {
    throw new Error("Transaktions-E-Mail ist nicht konfiguriert");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: env.TRANSACTIONAL_FROM,
      to: [to],
      subject,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(`E-Mail-Versand fehlgeschlagen: ${response.status}`);
  }
  return response.json();
}

export function declarationConfirmation({ type, receiptId, receivedAt, data, effectiveAt }) {
  const label = type === "widerruf" ? "Widerruf" : "Kündigung";
  return [
    `${label} – Eingangsbestätigung`,
    "",
    `Vorgangsnummer: ${receiptId}`,
    `Eingegangen am: ${receivedAt}`,
    `Name: ${data.name}`,
    `E-Mail: ${data.email}`,
    `Vertragsreferenz: ${data.contractReference}`,
    `Vertrag: ${data.contractLabel}`,
    data.declarationKind ? `Art: ${data.declarationKind}` : null,
    data.reason ? `Grund: ${data.reason}` : null,
    data.requestedEnd ? `Gewünschtes Ende: ${data.requestedEnd.toISOString()}` : null,
    effectiveAt ? `Vorgesehenes Vertragsende: ${effectiveAt}` : null,
    "",
    `Ihre Erklärung wurde am ${receivedAt} elektronisch übermittelt.`,
    "Kontakt: wasserentnahme-foehr@web.de",
  ].filter(Boolean).join("\n");
}
