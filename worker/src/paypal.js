// PayPal-Hilfsfunktionen: OAuth-Token holen, Webhook-Signatur prüfen,
// Abo-Details abfragen (für den täglichen Abgleich) und Abo kündigen.

async function holeZugriffstoken(env) {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth fehlgeschlagen: ${res.status}`);
  const daten = await res.json();
  return daten.access_token;
}

// Offizielle PayPal-Prüfung, ob ein eingegangener Webhook wirklich von
// PayPal stammt (statt die Signatur selbst kryptografisch nachzurechnen -
// das übernimmt PayPal auf Anfrage zuverlässiger).
export async function webhookIstEcht(env, headers, rohBody) {
  const token = await holeZugriffstoken(env);
  const payload = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(rohBody),
  };
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return false;
  const ergebnis = await res.json();
  return ergebnis.verification_status === "SUCCESS";
}

export async function holeAboDetails(env, paypalSubscriptionId) {
  const token = await holeZugriffstoken(env);
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/billing/subscriptions/${paypalSubscriptionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`PayPal Abo-Abfrage fehlgeschlagen: ${res.status}`);
  return res.json();
}

export async function kuendigeAbo(env, paypalSubscriptionId, grund) {
  const token = await holeZugriffstoken(env);
  const res = await fetch(
    `${env.PAYPAL_API_BASE}/v1/billing/subscriptions/${paypalSubscriptionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: grund || "Kuendigung durch Kunden" }),
    }
  );
  // 204 = erfolgreich gekuendigt
  return res.status === 204;
}
