#!/usr/bin/env node
// Ersetzt das manuelle Kopieren von dist/bundle.js in das Cloudflare-
// Dashboard. Einmalige Einrichtung: siehe README.md, Abschnitt "Deploy".
//
// Prueft vor dem eigentlichen Deploy, dass die KV-Bindung fuer RATE_KV in
// wrangler.toml eingetragen ist. Ohne diese Pruefung wuerde ein automatischer
// Deploy die im Dashboard von Hand verknuepfte Bindung stillschweigend
// entfernen (wrangler.toml ist die Quelle der Wahrheit fuer Bindings) und
// damit den Bruteforce-Schutz des Admin-Logins abschalten, ohne dass das
// auffaellt.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HIER = new URL(".", import.meta.url).pathname;
const wranglerToml = readFileSync(HIER + "wrangler.toml", "utf8");

const kvAktiv = /^\s*\[\[kv_namespaces\]\]/m.test(wranglerToml) &&
  /^\s*binding\s*=\s*"RATE_KV"/m.test(wranglerToml);

if (!kvAktiv) {
  console.error(
    "Abbruch: wrangler.toml enthaelt keine aktive KV-Bindung fuer RATE_KV.\n" +
    "Ohne diesen Eintrag wuerde ein automatischer Deploy den bestehenden\n" +
    "Bruteforce-Schutz fuer den Admin-Login stillschweigend abschalten.\n\n" +
    "Einmalig beheben:\n" +
    "  1. Cloudflare-Dashboard -> Workers & Pages -> KV -> Namespace RATE_KV\n" +
    "     oeffnen, die Namespace-ID kopieren.\n" +
    "  2. In wrangler.toml den auskommentierten [[kv_namespaces]]-Block\n" +
    "     aktivieren und die ID eintragen.\n"
  );
  process.exit(1);
}

console.log("→ Tests laufen ...");
execFileSync("node", ["--test", "test/*.test.js"], { cwd: HIER, stdio: "inherit", shell: true });

console.log("→ Deploy laeuft ...");
execFileSync("npx", ["wrangler", "deploy"], { cwd: HIER, stdio: "inherit" });

console.log("✓ Fertig deployed.");
