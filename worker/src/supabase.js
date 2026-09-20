// Kleiner Helfer für Zugriffe auf die Supabase-REST-API (PostgREST) mit
// dem Service-Role-Key. Läuft NUR im Worker, nie im Browser - der
// Service-Role-Key umgeht Row Level Security bewusst, weil hier jede
// Schreiboperation vorher serverseitig geprüft wurde.

export function supabaseClient(env) {
  const base = env.SUPABASE_URL + "/rest/v1";
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
  };

  async function request(path, options = {}) {
    const res = await fetch(base + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    // Einzelnen Datensatz oder Liste lesen (?spalte=eq.wert&select=...)
    select: (table, query = "") => request(`/${table}?${query}`, { method: "GET" }),

    // Neue Zeile(n) einfügen, gibt eingefügte Zeile(n) zurück
    insert: (table, rows) =>
      request(`/${table}`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(rows),
      }),

    // Zeilen aktualisieren, die den Query-Filter erfüllen
    update: (table, query, patch) =>
      request(`/${table}?${query}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      }),
  };
}

// Prüft ein Supabase-Auth-Zugriffstoken (JWT eines eingeloggten Kunden)
// und liefert die auth_user_id zurück, oder null wenn ungültig/abgelaufen.
export async function pruefeNutzerToken(env, accessToken) {
  const nutzer = await holeNutzer(env, accessToken);
  return nutzer ? nutzer.id : null;
}

// Wie pruefeNutzerToken, liefert aber den ganzen Nutzer (inkl. E-Mail).
export async function holeNutzer(env, accessToken) {
  const res = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + accessToken,
    },
  });
  if (!res.ok) return null;
  return res.json();
}
