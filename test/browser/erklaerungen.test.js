const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://127.0.0.1:8793';
const OUT = '/tmp/claude-0/-home-user-vereinsmanager/0d10283b-e0b1-544c-9b74-1390cffcad4f/scratchpad/shots';

function pruefe(name, bedingung) {
  console.log(`  ${bedingung ? 'BESTANDEN' : 'FEHLGESCHLAGEN'}  ${name}`);
  return bedingung;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // --- Bestellkarte: Beschriftung und Pflichtangaben ---
  console.log('Bestellablauf (registrieren.html)');
  const p1 = await browser.newPage({ viewport: { width: 420, height: 1100 } });
  await p1.goto(BASE + '/registrieren.html', { waitUntil: 'domcontentloaded' });
  await p1.evaluate(() => {
    document.getElementById('login-card').hidden = true;
    document.getElementById('order-card').hidden = false;
  });
  await p1.waitForTimeout(300);

  const btnText = (await p1.locator('#bestellen').textContent()).trim();
  pruefe(`Bestellbutton heißt "Zahlungspflichtig abonnieren" (ist: "${btnText}")`,
    btnText === 'Zahlungspflichtig abonnieren');

  // .toLowerCase(), weil die dt-Überschriften per CSS uppercase dargestellt
  // werden (innerText liefert den tatsächlich gerenderten Text).
  const uebersicht = (await p1.locator('.uebersicht').innerText()).toLowerCase();
  for (const begriff of ['Gesamtpreis', '12,00', '§ 19 UStG', 'PayPal', 'Mindestlaufzeit',
                         'Kündigung', 'Geräte', 'Anbieter', 'Widerrufsbelehrung']) {
    pruefe(`Bestellübersicht nennt "${begriff}"`, uebersicht.includes(begriff.toLowerCase()));
  }

  const vorbelegt = await p1.evaluate(() =>
    [...document.querySelectorAll('#order-card input[type=checkbox], #order-card input[type=radio]')]
      .filter((el) => el.checked).length);
  pruefe('keine vorangekreuzten Felder', vorbelegt === 0);

  const zahlschrittVorher = await p1.locator('#zahlschritt').isHidden();
  pruefe('Zahlschritt zunächst verborgen', zahlschrittVorher);

  await p1.locator('#bestellen').click();
  await p1.waitForTimeout(200);
  const meldung = await p1.locator('#order-status').innerText();
  pruefe(`ohne Zustimmung keine Bestellung möglich (Meldung: "${meldung.slice(0, 60)}")`,
    /nicht freigeschaltet|bestätigen/i.test(meldung));

  await p1.screenshot({ path: `${OUT}/lb-bestellung.png`, fullPage: true });
  await p1.close();

  // --- Kündigung: Zusammenfassung vor dem Absenden ---
  console.log('\nKündigung (kuendigen.html)');
  const p2 = await browser.newPage({ viewport: { width: 420, height: 1100 } });
  await p2.goto(BASE + '/kuendigen.html', { waitUntil: 'domcontentloaded' });
  await p2.fill('input[name=name]', 'Erika Musterfrau');
  await p2.fill('input[name=email]', 'erika@example.test');
  await p2.fill('input[name=vertragsreferenz]', 'LB-2026-ABCDEF1234');

  const datumGesperrt = await p2.locator('input[name=gewuenschtes_ende]').isDisabled();
  pruefe('Wunschdatum gesperrt, solange "frühestmöglich" gilt', datumGesperrt);

  await p2.locator('button[type=submit]').click();
  await p2.waitForTimeout(300);
  const sichtbar = await p2.locator('#zusammenfassung').isVisible();
  pruefe('Zusammenfassung erscheint vor dem Absenden', sichtbar);

  const zText = await p2.locator('#zusammenfassung').innerText();
  pruefe('Zusammenfassung zeigt den Namen', zText.includes('Erika Musterfrau'));
  pruefe('Zusammenfassung zeigt die Vertragsnummer', zText.includes('LB-2026-ABCDEF1234'));
  pruefe('Zusammenfassung nennt den frühestmöglichen Zeitpunkt',
    zText.includes('frühestmöglichen'));
  const absendeText = (await p2.locator('#absenden').textContent()).trim();
  pruefe(`Bestätigungsschaltfläche heißt "Jetzt kündigen" (ist: "${absendeText}")`,
    absendeText === 'Jetzt kündigen');

  await p2.screenshot({ path: `${OUT}/lb-kuendigung.png`, fullPage: true });

  await p2.locator('#zurueck').click();
  await p2.waitForTimeout(200);
  pruefe('"Angaben ändern" blendet die Zusammenfassung wieder aus',
    await p2.locator('#zusammenfassung').isHidden());
  await p2.close();

  // --- Widerruf: Zusammenfassung ---
  console.log('\nWiderruf (widerruf.html)');
  const p3 = await browser.newPage({ viewport: { width: 420, height: 1100 } });
  await p3.goto(BASE + '/widerruf.html', { waitUntil: 'domcontentloaded' });
  pruefe('ohne Anmeldung erreichbar', await p3.locator('#form').isVisible());
  await p3.fill('input[name=name]', 'Max Mustermann');
  await p3.fill('input[name=email]', 'max@example.test');
  await p3.fill('input[name=vertragsreferenz]', 'LB-2026-99AABBCCDD');
  await p3.locator('button[type=submit]').click();
  await p3.waitForTimeout(300);
  pruefe('Zusammenfassung erscheint', await p3.locator('#zusammenfassung').isVisible());
  const w = (await p3.locator('#absenden').textContent()).trim();
  pruefe(`Schaltfläche heißt "Widerruf bestätigen" (ist: "${w}")`, w === 'Widerruf bestätigen');
  await p3.screenshot({ path: `${OUT}/lb-widerruf.png`, fullPage: true });
  await p3.close();

  await browser.close();
})();
