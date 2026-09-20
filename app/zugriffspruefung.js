/* Prueft vor Nutzung der App, ob ein aktives, bezahltes Abo besteht.
   Wird als erstes Skript im <body> eingebunden (siehe registrieren.html-
   Wiring), blockiert per Overlay bis die Pruefung durchgelaufen ist.

   Offline-Gnadenfrist: 24 Stunden ab letzter erfolgreicher Pruefung, damit
   die App auch ohne Netz kurzzeitig nutzbar bleibt (Einsatzsituation).
   Laenger als das kann kein zuverlaessiger Abo-Schutz funktionieren - eine
   dauerhaft unbegrenzt offline nutzbare App laesst sich prinzipbedingt
   nicht zuverlaessig sperren. */

(function () {
  const SUPABASE_URL = "https://bmntahgtagjijfyeepju.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtbnRhaGd0YWdqaWpmeWVlcGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4OTE2ODEsImV4cCI6MjEwNTQ2NzY4MX0.YzXfS98rli0PvIXmIyBAg9KJjcOW2NlXZq9fHzpcA0g";
  const WORKER_URL = "https://loeschmeier-abo-worker.joerg-roeloffs.workers.dev";
  const GNADENFRIST_MS = 24 * 60 * 60 * 1000;
  const GERAET_KEY = "loeschmeier_abo_geraet_id";
  const ZUGRIFF_BIS_KEY = "loeschmeier_abo_zugriff_bis";

  const GRUENDE_TEXT = {
    nicht_angemeldet: "Bitte zuerst anmelden.",
    kein_profil: "Kein Kundenkonto gefunden. Bitte zuerst ein Abo abschließen.",
    kein_abo: "Kein Abo vorhanden. Bitte zuerst ein Abo abschließen.",
    manuell_gesperrt: "Dein Zugang wurde gesperrt. Bitte Kontakt aufnehmen.",
    bezahlter_zeitraum_beendet: "Der bezahlte Zeitraum ist abgelaufen.",
    geraetelimit_erreicht: "Maximale Anzahl Geräte erreicht. Bitte im Kundenbereich ein Gerät entfernen.",
  };

  function overlayErstellen() {
    const el = document.createElement("div");
    el.id = "abo-sperre";
    el.style.cssText =
      "position:fixed;inset:0;background:#0d1116;color:#e6edf3;z-index:99999;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "padding:24px;text-align:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;gap:14px";
    el.innerHTML = '<p id="abo-sperre-text" style="font-size:15px;max-width:320px">Prüfe Zugang ...</p>';
    document.body.prepend(el);
    return el;
  }

  function sperrenMitLink(nachricht) {
    const el = document.getElementById("abo-sperre") || overlayErstellen();
    el.innerHTML =
      '<p style="font-size:15px;max-width:320px">' + nachricht + "</p>" +
      '<a href="/registrieren.html" style="color:#2fa4ff">Zur Registrierung / Anmeldung</a>';
  }

  function freigeben() {
    const el = document.getElementById("abo-sperre");
    if (el) el.remove();
  }

  async function pruefen() {
    const overlay = overlayErstellen();

    let geraetId = localStorage.getItem(GERAET_KEY);
    if (!geraetId) {
      geraetId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
      localStorage.setItem(GERAET_KEY, geraetId);
    }

    const zugriffBisRoh = localStorage.getItem(ZUGRIFF_BIS_KEY);
    const zugriffBis = zugriffBisRoh ? new Date(zugriffBisRoh) : null;
    const nochInGnadenfrist = zugriffBis && zugriffBis > new Date();

    if (nochInGnadenfrist) freigeben();

    try {
      if (!window.supabase) {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
        document.head.appendChild(script);
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
        });
      }

      const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        if (!nochInGnadenfrist) sperrenMitLink(GRUENDE_TEXT.nicht_angemeldet);
        return;
      }

      const res = await fetch(
        WORKER_URL + "/api/zugriff?geraet=" + encodeURIComponent(geraetId),
        { headers: { Authorization: "Bearer " + session.access_token } }
      );
      const daten = await res.json();

      if (daten.erlaubt) {
        localStorage.setItem(ZUGRIFF_BIS_KEY, new Date(Date.now() + GNADENFRIST_MS).toISOString());
        freigeben();
      } else {
        localStorage.removeItem(ZUGRIFF_BIS_KEY);
        sperrenMitLink(GRUENDE_TEXT[daten.grund] || ("Kein Zugriff (" + daten.grund + ")"));
      }
    } catch (e) {
      // Netzwerkfehler (z.B. offline): nur sperren, wenn keine gueltige
      // Gnadenfrist mehr besteht.
      if (!nochInGnadenfrist) {
        sperrenMitLink("Keine Internetverbindung und keine gültige Offline-Berechtigung mehr. Bitte online gehen.");
      }
    }
  }

  pruefen();
})();
