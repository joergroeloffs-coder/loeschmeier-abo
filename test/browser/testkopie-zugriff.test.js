const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://127.0.0.1:8793';
let fehlgeschlagen = 0;
function pruefe(name, ok, zusatz = '') {
  if (!ok) fehlgeschlagen++;
  console.log(`  ${ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}  ${name}${zusatz ? ' — ' + zusatz : ''}`);
}

function stub(session, antwort) {
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
  }).toString()})(${JSON.stringify(session)}, ${JSON.stringify(antwort)})`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  console.log('Testkopie der App in loeschmeier-abo/app/nutzer/');

  // Der frueher wirksame Umgehungsweg: Gnadenfrist per localStorage setzen.
  let page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.addInitScript({ content: stub(false, { erlaubt: false, grund: 'kein_abo' }) });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('loeschmeier_abo_zugriff_bis', new Date(Date.now() + 9e8).toISOString());
      localStorage.setItem('wasserentnahme.test.nutzer.freigabestart', String(Date.now()));
    } catch (e) {}
  });
  await page.goto(BASE + '/nutzer/?freigabe=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  pruefe('manipuliertes localStorage öffnet die Testkopie nicht mehr',
    await page.evaluate(() => Boolean(document.getElementById('zugang-sperre'))));
  await page.close();

  // Ohne Anmeldung gesperrt
  page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.addInitScript({ content: stub(false, { erlaubt: false, grund: 'kein_abo' }) });
  await page.goto(BASE + '/nutzer/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  pruefe('ohne Anmeldung gesperrt',
    await page.evaluate(() => Boolean(document.getElementById('zugang-sperre'))));
  await page.close();

  // Mit gueltigem Abo frei
  page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  await page.addInitScript({ content: stub(true, { erlaubt: true, status: 'aktiv', betreiber: false }) });
  await page.goto(BASE + '/nutzer/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const frei = await page.evaluate(() => ({
    gesperrt: Boolean(document.getElementById('zugang-sperre')),
    eintraege: document.querySelectorAll('#v-liste .treffer, #v-liste li, #liste > *').length,
  }));
  pruefe('aktives Abo gibt frei', !frei.gesperrt);
  pruefe('Daten werden geladen', frei.eintraege > 0, `${frei.eintraege} Einträge`);
  await page.close();

  await browser.close();
  console.log(fehlgeschlagen === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehlgeschlagen} fehlgeschlagen.`);
  process.exit(fehlgeschlagen === 0 ? 0 : 1);
})();
