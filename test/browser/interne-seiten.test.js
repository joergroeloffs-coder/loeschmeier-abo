/* Prueft, dass die internen Seiten ein Betreiberkonto verlangen und die
   Nutzerseite einen aktiven Jahreszugang. Supabase und Worker sind
   nachgebildet; es werden keine echten Konten und keine Zahlung benutzt.

   Start:  cd app && python3 -m http.server 8799
           node test/browser/interne-seiten.test.js
*/
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8799';

let fehlgeschlagen = 0;
function pruefe(name, ok, zusatz = '') {
  if (!ok) fehlgeschlagen++;
  console.log(`  ${ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}  ${name}${zusatz ? ' — ' + zusatz : ''}`);
}

function stub(angemeldet, antwort) {
  return `(${((s, a) => {
    const sitzung = s
      ? { access_token: 't', user: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', email: 'k@example.test' } }
      : null;
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: sitzung } }),
          signInWithOtp: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
      }),
    };
    const echtesFetch = window.fetch;
    window.fetch = async (url, o) => {
      const adresse = String(url);
      if (adresse.includes('/api/zugriff')) {
        return new Response(JSON.stringify(a), { status: a.erlaubt ? 200 : 403 });
      }
      if (adresse.includes('/api/stellen')) {
        return new Response(JSON.stringify({ fehler: 'nicht_konfiguriert' }), { status: 503 });
      }
      return echtesFetch(url, o);
    };
  }).toString()})(${JSON.stringify(angemeldet)}, ${JSON.stringify(antwort)})`;
}

async function zustand(browser, pfad, angemeldet, antwort) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript({ content: stub(angemeldet, antwort) });
  await page.goto(BASE + pfad, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const ergebnis = await page.evaluate(() => ({
    gesperrt: Boolean(document.getElementById('zugang-sperre')),
    hinweis: document.getElementById('zugang-hinweis')?.textContent?.trim() || '',
  }));
  await page.close();
  return ergebnis;
}

const KUNDE = { erlaubt: true, status: 'aktiv', betreiber: false };
const BETRIEB = { erlaubt: true, status: 'betreiber', betreiber: true };
const OHNE_ABO = { erlaubt: false, grund: 'kein_abo' };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  console.log('Datenpflege (verwaltung.html)');
  let r = await zustand(browser, '/verwaltung.html', false, OHNE_ABO);
  pruefe('ohne Anmeldung gesperrt', r.gesperrt, r.hinweis);
  r = await zustand(browser, '/verwaltung.html', true, KUNDE);
  pruefe('angemeldeter Kunde ohne Betreiberrecht gesperrt', r.gesperrt, r.hinweis);
  r = await zustand(browser, '/verwaltung.html', true, BETRIEB);
  pruefe('Betreiberkonto frei', !r.gesperrt);

  console.log('\nInterne Nutzerverwaltung (nutzer-admin/)');
  r = await zustand(browser, '/nutzer-admin/', true, KUNDE);
  pruefe('Kunde gesperrt', r.gesperrt, r.hinweis);
  r = await zustand(browser, '/nutzer-admin/', true, BETRIEB);
  pruefe('Betreiberkonto frei', !r.gesperrt);

  console.log('\nNutzerversion (nutzer/)');
  r = await zustand(browser, '/nutzer/', true, OHNE_ABO);
  pruefe('ohne Abo gesperrt', r.gesperrt, r.hinweis);
  r = await zustand(browser, '/nutzer/', true, KUNDE);
  pruefe('mit Abo frei, auch ohne Betreiberrecht', !r.gesperrt);

  console.log('\nOeffentliche Seiten muessen erreichbar bleiben');
  for (const pfad of ['/kuendigen.html', '/widerruf.html', '/agb.html', '/impressum.html', '/registrieren.html']) {
    r = await zustand(browser, pfad, false, OHNE_ABO);
    pruefe(`ohne Anmeldung erreichbar: ${pfad}`, !r.gesperrt);
  }

  await browser.close();
  console.log(fehlgeschlagen === 0 ? '\nAlle Pruefungen bestanden.' : `\n${fehlgeschlagen} fehlgeschlagen.`);
  process.exit(fehlgeschlagen === 0 ? 0 : 1);
})();
