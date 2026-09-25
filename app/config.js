/* Ortsspezifische Einstellungen. Diese Datei ist die EINZIGE Stelle, die sich
   zwischen den verschiedenen Gemeinde-Versionen der App unterscheiden soll -
   alle anderen Dateien (index.html, nutzer/, nutzer-admin/, sw.js, vendor/)
   bleiben zwischen den Versionen identisch und werden per Sync-Skript
   (werkzeuge/sync_core.py) synchron gehalten. */
self.APP_CONFIG = {
  ortName: "Test",

  // Startposition/Zoom der Karte (gleiche Gegend wie Leck, nur zum Testen)
  kartenMitte: [54.751, 8.984],
  kartenZoomUebersicht: 12,
  kartenZoomPeil: 13,
  kartenZoomDetail: 14,

  // Dateiname der Offline-Kartendatei in daten/ (ohne Pfad). Auf null lassen,
  // solange für diese Gemeinde noch keine PMTiles-Datei erzeugt wurde -
  // die App nutzt dann automatisch normale Online-Kartenkacheln als Fallback.
  pmtilesDatei: null,

  // Basis für alle localStorage-Schlüssel dieser Version (muss sich von allen
  // anderen Gemeinden UND von den anderen Apps derselben Gemeinde unterscheiden,
  // sonst teilen sich Versionen auf github.io denselben Browser-Speicher).
  speicherPraefix: "wasserentnahme.test",

  // Nur Nutzerversion: Zieladresse für Positions-/Korrekturmeldungen.
  kontaktEmail: "wasserentnahme-foehr@web.de",

  // Nur Hauptversion: Zusammenfassung benachbarter Ortsteile in der Ortschafts-
  // Auswahl/Filterung. Leer lassen ({}), wenn nicht gebraucht.
  ortschaftGruppen: {},

  // Nur Nutzerversion: Cloudflare-Worker-Adresse für das Geräte-Limit
  // (max. 2 Geräte pro Zugangsnummer). Leer lassen (null), wenn nicht gebraucht.
  zugangsWorkerUrl: "https://wasserentnahme-zugang.joerg-roeloffs.workers.dev/",

  // Zentrale Vertrags- und Zugriffsprüfung. Der Worker-Name stammt aus der
  // Zeit vor der Umbenennung; eine Änderung würde die bestehende Adresse und
  // damit den laufenden Betrieb brechen.
  aboWorkerUrl: "https://loeschbaert-worker.joerg-roeloffs.workers.dev",
  supabaseUrl: "https://bmntahgtagjijfyeepju.supabase.co",
  // Öffentlicher anon-Schlüssel, für den Browser vorgesehen. Der
  // service_role-Schlüssel steht ausschließlich im Worker.
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtbnRhaGd0YWdqaWpmeWVlcGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4OTE2ODEsImV4cCI6MjEwNTQ2NzY4MX0.YzXfS98rli0PvIXmIyBAg9KJjcOW2NlXZq9fHzpcA0g",
  bestellSeite: "/registrieren.html"
};
