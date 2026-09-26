const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Wallet } = require('ethers');

const providerWallet = Wallet.createRandom();
const providerProfiles = JSON.stringify({
  [providerWallet.address]: { id: 'verified-firin', name: 'Doğrulanmış Fırın', location: 'Beyoğlu', registrationNumber: 'TR-TEST-2026-001', verifiedAt: '2026-09-26', status: 'active' },
});

async function loginProvider(request) {
  const challengeResponse = await request.get(`http://127.0.0.1:4177/api/provider/challenge?address=${providerWallet.address}`);
  assert.equal(challengeResponse.status(), 200, 'Wallet challenge is available');
  const challenge = await challengeResponse.json();
  const signature = await providerWallet.signMessage(challenge.message);
  const login = await request.post('http://127.0.0.1:4177/api/provider/login', { data: { address: providerWallet.address, signature } });
  assert.equal(login.status(), 200, 'Signed Monad wallet opens a provider session');
  return login.json();
}

(async () => {
  let demoServer;
  try { const health = await fetch('http://127.0.0.1:4177/health'); if (!health.ok) throw new Error('health'); }
  catch {
    demoServer = spawn(process.execPath, ['server.mjs'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: { ...process.env, HACKATHON_MODE: '0', PROVIDER_WALLETS_JSON: providerProfiles } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { const health = await fetch('http://127.0.0.1:4177/health'); if (health.ok) break; } catch {}
      if (attempt === 29) throw new Error('Demo server did not start');
    }
  }
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const intruderPublish = await page.request.post('http://127.0.0.1:4177/api/publish', { data: { title: 'Sahte paket', quantity: 4 } });
    assert.equal(intruderPublish.status(), 403, 'Publishing requires the provider role');
    const unapprovedWallet = Wallet.createRandom();
    const unapprovedChallenge = await (await page.request.get(`http://127.0.0.1:4177/api/provider/challenge?address=${unapprovedWallet.address}`)).json();
    const unapprovedLogin = await page.request.post('http://127.0.0.1:4177/api/provider/login', { data: { address: unapprovedWallet.address, signature: await unapprovedWallet.signMessage(unapprovedChallenge.message) } });
    assert.equal(unapprovedLogin.status(), 403, 'A wallet signature alone never grants a business role');
    const applicationChallenge = await (await page.request.get(`http://127.0.0.1:4177/api/provider/challenge?purpose=application&address=${unapprovedWallet.address}`)).json();
    const application = await page.request.post('http://127.0.0.1:4177/api/provider/apply', { data: {
      address: unapprovedWallet.address,
      signature: await unapprovedWallet.signMessage(applicationChallenge.message),
      businessName: 'Başvuran Test Fırını',
      registrationNumber: 'TR-TEST-NEW-001',
      businessAddress: 'Caferağa Mahallesi, Test Caddesi No:12, Kadıköy / İstanbul',
      officialQr: true,
    } });
    assert.equal(application.status(), 202, 'Signed application is stored as pending');
    assert.equal((await application.json()).application.status, 'pending', 'Application cannot approve itself');
    const pendingLoginChallenge = await (await page.request.get(`http://127.0.0.1:4177/api/provider/challenge?address=${unapprovedWallet.address}`)).json();
    const pendingLogin = await page.request.post('http://127.0.0.1:4177/api/provider/login', { data: { address: unapprovedWallet.address, signature: await unapprovedWallet.signMessage(pendingLoginChallenge.message) } });
    assert.equal(pendingLogin.status(), 403, 'Pending applicant still cannot publish');
    assert.match((await pendingLogin.json()).error, /incelemede/i);
    await loginProvider(page.request);
    await page.request.post('http://127.0.0.1:4177/api/reset');
    const managedDeadline = new Date(Date.now() + 3 * 60 * 60_000);
    const managedPrepared = new Date();
    const managedDate = `${managedDeadline.getFullYear()}-${String(managedDeadline.getMonth() + 1).padStart(2, '0')}-${String(managedDeadline.getDate()).padStart(2, '0')}`;
    const managedTime = `${String(managedDeadline.getHours()).padStart(2, '0')}:${String(managedDeadline.getMinutes()).padStart(2, '0')}`;
    const managedPreparedTime = `${String(managedPrepared.getHours()).padStart(2, '0')}:${String(managedPrepared.getMinutes()).padStart(2, '0')}`;
    const managedPublish = await page.request.post('http://127.0.0.1:4177/api/publish', { data: { businessName: 'Doğrulanmış Fırın', title: 'Yönetilecek paket', contents: 'Test içeriği', quantity: 3, pickupDate: managedDate, deadline: managedTime, preparedAt: managedPreparedTime, claimTtlMinutes: 45, allergens: 'Yok', address: 'Test Mahallesi No:10, İstanbul', latitude: 41.03, longitude: 28.98 } });
    assert.equal(managedPublish.status(), 200);
    const managedBatch = (await managedPublish.json()).batches.find(batch => batch.title === 'Yönetilecek paket');
    assert.equal(managedBatch.claimTtlSeconds, 45 * 60, 'Published batch keeps the business-selected claim duration');
    const managedUpdate = await page.request.post('http://127.0.0.1:4177/api/batch/update', { data: { batchId: managedBatch.id, title: 'Güncellenmiş paket', contents: 'Yeni içerik', quantity: 4, pickupDate: managedDate, deadline: managedTime, claimTtlMinutes: 60, allergens: 'Gluten' } });
    assert.equal(managedUpdate.status(), 200, 'Provider can update its active publication');
    assert.equal((await managedUpdate.json()).batches.find(batch => batch.id === managedBatch.id).claimTtlSeconds, 60 * 60, 'Provider can update the duration for future claims');
    const notifiedDevice = '00000000-0000-4000-8000-000000000099';
    assert.equal((await page.request.post('http://127.0.0.1:4177/api/claim', { data: { deviceId: notifiedDevice, batchId: managedBatch.id } })).status(), 200);
    const managedCancel = await page.request.post('http://127.0.0.1:4177/api/batch/cancel', { data: { batchId: managedBatch.id, reason: 'İmha edildi', note: 'Soğuk zincir kesintisi fark edildi.' } });
    assert.equal(managedCancel.status(), 200, 'Provider can close a publication with a reason');
    const notifiedState = await (await page.request.get(`http://127.0.0.1:4177/api/state?deviceId=${notifiedDevice}`)).json();
    assert.match(notifiedState.notices[0].message, /İmha edildi.*Soğuk zincir/i, 'Claim owner receives the cancellation reason');
    assert.equal(notifiedState.batches.find(batch => batch.id === managedBatch.id).slots.some(slot => slot.state === 'claimed'), false, 'Cancelled publication invalidates active pickup codes');
    await page.request.post('http://127.0.0.1:4177/api/reset');
    const pastPublish = await page.request.post('http://127.0.0.1:4177/api/publish', {
      data: { title: 'Süresi geçmiş paket', contents: 'Test paketi', quantity: 2, pickupDate: '2020-01-01', deadline: '10:00', preparedAt: '09:00', allergens: 'Yok', address: 'Test adresi', latitude: 41.03, longitude: 28.98 },
    });
    assert.equal(pastPublish.status(), 409, 'Past food deadlines are rejected');
    const duplicateDevice = '00000000-0000-4000-8000-000000000001';
    assert.equal((await page.request.post('http://127.0.0.1:4177/api/claim', { data: { deviceId: duplicateDevice, batchId: 'firin' } })).status(), 200);
    assert.equal((await page.request.post('http://127.0.0.1:4177/api/claim', { data: { deviceId: duplicateDevice, batchId: 'firin' } })).status(), 409, 'One device cannot hold two slots in one batch');
    assert.equal((await page.request.post('http://127.0.0.1:4177/api/claim', { data: { deviceId: duplicateDevice, batchId: 'moda' } })).status(), 409, 'One device cannot hold claims across different businesses');
    await page.request.post('http://127.0.0.1:4177/api/reset');
    await page.context().clearCookies();
    await page.exposeFunction('__signProviderMessage', message => providerWallet.signMessage(message));
    await page.addInitScript(({ address }) => {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: success => success({ coords: { latitude: 41.0327, longitude: 28.9832, accuracy: 12 } }) } });
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'personal_sign') {
            const bytes = new Uint8Array(params[0].slice(2).match(/.{1,2}/g).map(value => Number.parseInt(value, 16)));
            return window.__signProviderMessage(new TextDecoder().decode(bytes));
          }
          throw new Error(`Unsupported wallet test method: ${method}`);
        },
        on: () => {},
      };
    }, { address: providerWallet.address });

    await page.goto('http://127.0.0.1:4177');
    await page.evaluate(() => localStorage.removeItem('sonporsiyon-device'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No desktop horizontal overflow');
    assert.equal(await page.getByRole('heading', { name: /Yakında kalan/ }).isVisible(), true);
    assert.equal(await page.locator('.package-card').count(), 2, 'The featured batch is not repeated in the alternatives grid');
    assert.equal(await page.locator('.package-card').filter({ hasText: 'Moda Yemekhane' }).count(), 1, 'Users can distinguish providers');
    assert.equal(await page.locator('#featuredImage').getAttribute('src'), '/assets/komsu-firin.jpg', 'Featured business uses its own package photo');
    for (const asset of ['komsu-firin.jpg', 'moda-yemekhane.jpg', 'aksam-kafe.jpg']) assert.equal((await page.request.get(`http://127.0.0.1:4177/assets/${asset}`)).status(), 200, `${asset} is served locally`);
    assert.match(await page.locator('#networkSummary').textContent(), /Demo verisi dahil.*3 teslim noktasında 18 ücretsiz porsiyon/);
    assert.equal(await page.locator('#redeemCode').isHidden(), true, 'Consumer route never exposes the delivery desk');
    await page.getByRole('button', { name: 'KONUMUMA GÖRE SIRALA' }).click();
    await page.getByText(/12 m doğruluk/).waitFor();
    assert.match(await page.locator('#featuredProvider').textContent(), /KOMŞU FIRIN/);
    const mapBox = await page.locator('.mini-map').boundingBox();
    const pinBoxes = await page.locator('.mini-map .real-pin').evaluateAll(pins => pins.map(pin => {
      const box = pin.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.ok(pinBoxes.every(pin => pin.x >= mapBox.x && pin.y >= mapBox.y && pin.x + pin.width <= mapBox.x + mapBox.width && pin.y + pin.height <= mapBox.y + mapBox.height), 'Map pins stay within the visible map');
    for (let first = 0; first < pinBoxes.length; first += 1) for (let second = first + 1; second < pinBoxes.length; second += 1) {
      const a = pinBoxes[first]; const b = pinBoxes[second];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'Map pins do not overlap');
    }
    const focusButton = page.locator('.package-card').first().getByRole('button', { name: 'BU PAKETİ AYIR' });
    const focusedBatchId = await focusButton.getAttribute('data-claim-batch');
    await focusButton.focus();
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.claimBatch || ''), focusedBatchId, 'Polling preserves keyboard focus');

    await page.getByRole('link', { name: 'İşletmeler için' }).click();
    await page.waitForURL('http://127.0.0.1:4177/isletme');
    assert.equal(await page.getByRole('heading', { name: /Fazlayı yayınla/ }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#providerView h1')), false, 'Business page does not draw a focus ring around the heading on initial load');
    assert.equal(await page.locator('#discoverView').isHidden(), true, 'Business route does not expose the consumer marketplace');
    assert.equal(await page.getByRole('button', { name: 'MONAD CÜZDANINI BAĞLA' }).isVisible(), true);
    await page.getByRole('button', { name: 'MONAD CÜZDANINI BAĞLA' }).click();
    await page.locator('#providerWorkspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#providerWallet').textContent(), `${providerWallet.address.slice(0, 6)}…${providerWallet.address.slice(-4)}`);
    await page.locator('#publishForm input[name="address"]').fill('Kılıçali Paşa Mah., Akarsu Cd. No:20, Beyoğlu');
    await page.locator('#publishForm select[name="claimTtlMinutes"]').selectOption('60');
    await page.getByRole('button', { name: 'TESLİM NOKTASININ KONUMUNU AL' }).click();
    await page.getByText(/Konum eklendi/).waitFor();
    await page.locator('#publishForm input[name="safety"]').check();
    await page.locator('#publishForm').getByRole('button', { name: /Partiyi yayınla/ }).click();
    await page.getByText(/8 porsiyonluk paket listesi yayınlandı/).waitFor();
    const consumerPublishState = await (await page.request.get('http://127.0.0.1:4177/api/state')).json();
    assert.equal(consumerPublishState.batches.find(batch => batch.title === 'Gün sonu sandviç paketi').claimTtlSeconds, 60 * 60);
    assert.equal(consumerPublishState.chain.enabled, false, 'Local demo states clearly that Monad writes are not active without testnet credentials');
    const publishedListing = page.locator('.provider-listing-card').filter({ hasText: 'Gün sonu sandviç paketi' });
    const cancellationReason = publishedListing.getByLabel('Yayını kapatma nedeni');
    const cancellationNote = publishedListing.getByLabel('Kapatma notu');
    await cancellationReason.selectOption('Yayın hatası');
    await cancellationNote.fill('Kullanıcıya gösterilecek deneme notu');
    await cancellationNote.focus();
    await page.waitForTimeout(1300);
    assert.equal(await cancellationReason.inputValue(), 'Yayın hatası', 'Cancellation reason survives background synchronization');
    assert.equal(await cancellationNote.inputValue(), 'Kullanıcıya gösterilecek deneme notu', 'Consumer notice survives background synchronization');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.cancelNote || ''), await cancellationNote.getAttribute('data-cancel-note'), 'Typing focus survives background synchronization');
    await page.goto('http://127.0.0.1:4177');

    const selectedPackage = page.locator('.featured').filter({ hasText: 'Gün sonu sandviç paketi' });
    const selectedClaimButton = selectedPackage.locator('.claim');
    assert.match(await selectedClaimButton.innerText(), /1 porsiyon ayır/i);
    await selectedClaimButton.click();
    await page.locator('#pickupDialog').waitFor({ state: 'visible' });
    const releasedCode = await page.locator('#pickupCode').textContent();
    assert.match(releasedCode, /^SP-[A-Z0-9]{4}$/);
    await page.getByRole('button', { name: 'Tamam', exact: true }).click();
    await page.waitForTimeout(550);
    const firstRemaining = await selectedClaimButton.locator('b').textContent();
    assert.match(firstRemaining, /^KALAN \d{2}:\d{2}$/, 'Claim button shows the live remaining time');
    await page.waitForTimeout(1100);
    const nextRemaining = await selectedClaimButton.locator('b').textContent();
    assert.match(nextRemaining, /^KALAN \d{2}:\d{2}$/);
    assert.notEqual(nextRemaining, firstRemaining, 'Remaining time keeps counting down after the dialog closes and state refreshes');
    await page.locator('#myPickup').click();
    await page.getByRole('button', { name: 'Paketi geri bırak' }).click();
    await page.locator('#pickupDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#myPickup span').textContent(), '0', 'Released claim is no longer held');
    assert.ok(await page.locator('.package-card button[data-claim-batch]:enabled').count() >= 2, 'Other packages become selectable after release');
    assert.match(await selectedPackage.innerText(), /AYIRINCA 60 DK/);
    await selectedClaimButton.click();
    await page.locator('#pickupDialog').waitFor({ state: 'visible' });
    const code = await page.locator('#pickupCode').textContent();
    assert.notEqual(code, releasedCode, 'Re-claim receives a new one-time pickup code');
    await page.getByRole('button', { name: 'Tamam', exact: true }).click();

    const secondContext = await browser.newContext({ viewport: { width: 420, height: 860 } });
    const second = await secondContext.newPage();
    await second.goto('http://127.0.0.1:4177');
    await second.locator('.claim').click();
    await second.locator('#pickupDialog').waitFor({ state: 'visible' });
    const secondCode = await second.locator('#pickupCode').textContent();
    assert.notEqual(secondCode, code, 'Different devices receive different shared slots/codes');

    await page.goto('http://127.0.0.1:4177/isletme');
    await page.locator('#redeemCode').fill(code);
    await page.getByRole('button', { name: 'TESLİMİ ONAYLA' }).click();
    await page.getByText(/kapatıldı$/, { exact: false }).first().waitFor();

    const before = Number(await page.locator('#publishedMetric').textContent());
    await page.locator('#publishForm input[name="safety"]').check();
    await page.locator('#publishForm').getByRole('button', { name: /Partiyi yayınla/ }).click();
    await page.goto('http://127.0.0.1:4177');
    await page.locator('#featuredTitle', { hasText: 'Gün sonu sandviç paketi' }).waitFor();
    await page.getByRole('button', { name: 'Canlı durum' }).click();
    await page.waitForURL(/\?view=impact$/);
    assert.equal(await page.getByRole('heading', { name: /Bugünkü paylaşım/ }).isVisible(), true, 'Impact view has a shareable URL');
    assert.equal(Number(await page.locator('#publishedMetric').textContent()), before + 8);
    assert.equal(Number(await page.locator('#redeemedMetric').textContent()), 1);
    assert.equal(Number(await page.locator('#claimedMetric').textContent()), 1);
    await page.getByRole('link', { name: 'SonPorsiyon paketlerine dön' }).click();
    await page.waitForURL('http://127.0.0.1:4177/');
    assert.equal(await page.getByRole('heading', { name: /Yakında kalan/ }).isVisible(), true, 'Brand returns to the package list');
    await page.goto('http://127.0.0.1:4177/isletme');
    await page.locator('#redeemCode').fill(secondCode);
    await page.getByRole('button', { name: 'TESLİMİ ONAYLA' }).click();
    await second.locator('#pickupDialog').waitFor({ state: 'hidden', timeout: 4000 });
    assert.equal(await second.locator('#mobilePickup').isHidden(), true, 'Remote redeem invalidates the consumer pickup UI');
    await secondContext.close();
    await page.getByRole('button', { name: 'ÇIKIŞ YAP' }).click();
    await page.locator('#providerWorkspace').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'MONAD CÜZDANINI BAĞLA' }).isVisible(), true, 'Provider can end the wallet session');

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto('http://127.0.0.1:4177');
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
    const claimBox = await mobile.locator('.claim').boundingBox();
    assert.ok(claimBox.y + claimBox.height <= 844, 'Primary action is fully visible in first mobile viewport');
    const locationBox = await mobile.locator('.location-button-mobile').boundingBox();
    const marketBox = await mobile.locator('.package-market').boundingBox();
    assert.ok(locationBox.y < marketBox.y, 'Mobile location sorting appears before the package list');
    assert.equal(await mobile.getByRole('button', { name: 'Paketler' }).isVisible(), true);
    const mobileTargets = await mobile.locator('.nav-pill:visible, footer a:visible').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { label: element.textContent.trim(), width: box.width, height: box.height };
    }));
    assert.ok(mobileTargets.length >= 3, 'Mobile navigation and footer actions are present');
    assert.ok(mobileTargets.every(target => target.width >= 44 && target.height >= 44), `Mobile navigation targets are at least 44px: ${JSON.stringify(mobileTargets)}`);
    assert.equal(await mobile.getByText(/Demo verisi dahil/i).isVisible(), true, 'Seeded hackathon inventory is clearly labeled as demo data');
    await mobile.close();
    assert.deepEqual(errors.filter(error => !/rpc\.monad\.xyz/i.test(error)), []);
    console.log('PASS: reserve, pickup code, redeem, publish, impact metrics, desktop and mobile layout.');
  } finally { await browser.close(); demoServer?.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
