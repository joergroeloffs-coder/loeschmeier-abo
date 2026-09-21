const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://127.0.0.1:8793';
const OUT = '/tmp/claude-0/-home-user-vereinsmanager/0d10283b-e0b1-544c-9b74-1390cffcad4f/scratchpad/shots';

let fehlgeschlagen = 0;
function pruefe(name, ok, zusatz = '') {
  if (!ok) fehlgeschlagen++;
  console.log(`  ${ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}  ${name}${zusatz ? ' — ' + zusatz : ''}`);
}

// Ersatz fuer Supabase und den Worker, damit der angemeldete Bestellablauf
// ohne echte Zugangsdaten und ohne echte Zahlung pruefbar ist.
const STUB = () => {
  const session = {
    access_token: 'test-token',
    user: { id: '11111111-2222-3333-4444-555555555555', email: 'testkunde@example.test' },
  };
  window.__paypalAufrufe = [];
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session } }),
        signInWithOtp: async () => ({ error: null }),
        signOut: async () => ({}),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: async () => ({ data: [] }),
            in: () => ({ limit: async () => ({ data: [] }) }),
          }),
        }),
      }),
    }),
  };
  // PayPal-SDK durch eine Attrappe ersetzen: sie zeichnet nur auf.
  window.paypal = {
    Buttons: (optionen) => ({
      render: (ziel) => {
        window.__paypalOptionen = optionen;
        const knopf = document.createElement('button');
        knopf.id = 'paypal-attrappe';
        knopf.textContent = 'PayPal (Attrappe)';
        document.querySelector(ziel).appendChild(knopf);
      },
    }),
  };
  const echtesFetch = window.fetch;
  window.fetch = async (url, optionen) => {
    const adresse = String(url);
    if (adresse.includes('/api/katalog')) {
      return new Response(
        JSON.stringify({
          verkaufAktiv: true,
          paypalClientId: 'TEST-CLIENT',
          tarife: [{
            code: 'foehr-jahr', slug: 'loeschbaert-foehr-privat',
            bezeichnung: 'Löschbärt Föhr – Jahreszugang',
            preis_cent: 1200, waehrung: 'EUR', intervall: '12_monate',
            max_geraete: 2, kaufbar: true, paypalPlanId: 'P-TEST',
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return echtesFetch(url, optionen);
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 420, height: 1100 } });
  await page.addInitScript(STUB);
  // Das echte PayPal-SDK darf nicht geladen werden.
  await page.route('**/www.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* Attrappe: window.paypal steht bereits */' }));
  await page.goto(BASE + '/registrieren.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  console.log('Angemeldeter Bestellablauf');
  pruefe('Bestellkarte sichtbar nach Anmeldung', await page.locator('#order-card').isVisible());
  pruefe('Verkauf laut Katalog freigeschaltet',
    (await page.locator('#sales-notice').innerText()).includes('freigeschaltet'));

  const uebersicht = (await page.locator('.uebersicht').innerText()).toLowerCase();
  for (const begriff of ['gesamtpreis', '12,00', '§ 19 ustg', 'paypal', 'mindestlaufzeit',
                         'kündigung', 'geräte', 'anbieter', 'widerrufsbelehrung', 'voraussetzungen']) {
    pruefe(`Bestellübersicht nennt "${begriff}"`, uebersicht.includes(begriff));
  }

  // 1. Ohne Zustimmung darf nichts passieren.
  await page.locator('#bestellen').click();
  await page.waitForTimeout(200);
  pruefe('ohne AGB-Zustimmung kein Zahlschritt', await page.locator('#zahlschritt').isHidden(),
    (await page.locator('#order-status').innerText()).slice(0, 50));

  // 2. Zustimmung, aber ohne Wahl des Leistungsbeginns.
  await page.locator('#terms').check();
  await page.locator('#bestellen').click();
  await page.waitForTimeout(200);
  pruefe('ohne Wahl des Leistungsbeginns kein Zahlschritt',
    await page.locator('#zahlschritt').isHidden(),
    (await page.locator('#order-status').innerText()).slice(0, 60));

  // 3. Vollstaendig: jetzt erst darf PayPal erscheinen.
  await page.locator('input[name=start][value=later]').check();
  await page.locator('#bestellen').click();
  await page.waitForTimeout(600);
  pruefe('nach vollständiger Bestellung erscheint der Zahlschritt',
    await page.locator('#zahlschritt').isVisible());
  pruefe('PayPal-Button wird erst danach erzeugt',
    await page.locator('#paypal-attrappe').count() > 0);

  // 4. Die an PayPal uebergebenen Daten pruefen.
  const abo = await page.evaluate(() => {
    const o = window.__paypalOptionen;
    if (!o) return null;
    let erfasst = null;
    o.createSubscription({}, {
      subscription: { create: (daten) => { erfasst = daten; return Promise.resolve('I-TEST'); } },
    });
    return erfasst;
  });
  pruefe('richtige Plan-ID wird übergeben', abo && abo.plan_id === 'P-TEST', JSON.stringify(abo));
  pruefe('Konto-Bindung über custom_id',
    abo && abo.custom_id === '11111111-2222-3333-4444-555555555555');
  pruefe('Leistungsbeginn erst nach 14 Tagen (kein sofortiger Beginn gewählt)',
    abo && typeof abo.start_time === 'string' &&
      Math.round((new Date(abo.start_time) - Date.now()) / 86400000) === 14,
    abo && abo.start_time);

  // 5. Sofortiger Beginn: dann darf kein start_time gesetzt sein.
  await page.locator('input[name=start][value=now]').check();
  const aboSofort = await page.evaluate(() => {
    let erfasst = null;
    window.__paypalOptionen.createSubscription({}, {
      subscription: { create: (daten) => { erfasst = daten; return Promise.resolve('I-TEST'); } },
    });
    return erfasst;
  });
  pruefe('bei sofortigem Beginn kein verzögerter Start',
    aboSofort && !aboSofort.start_time);

  await page.screenshot({ path: `${OUT}/lb-bestellung.png`, fullPage: true });
  await page.close();
  await browser.close();
  console.log(fehlgeschlagen === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehlgeschlagen} Prüfung(en) fehlgeschlagen.`);
  process.exit(fehlgeschlagen === 0 ? 0 : 1);
})();
