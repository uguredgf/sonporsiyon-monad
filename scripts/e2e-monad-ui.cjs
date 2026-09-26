const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Wallet } = require('ethers');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4177';
const providerWallet = Wallet.createRandom();
const title = `Monad zincir paketi ${Date.now().toString(36)}`;

function istanbulParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  const context = await browser.newContext({
    geolocation: { latitude: 41.0327, longitude: 28.9832 },
    permissions: ['geolocation'],
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  try {
    await page.exposeFunction('__signProviderMessage', message => providerWallet.signMessage(message));
    await page.addInitScript(({ address }) => {
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

    const state = await (await context.request.get(`${baseUrl}/api/state?deviceId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)).json();
    assert.equal(state.chain.enabled, true, 'Server must be running in Monad mode');

    await page.goto(`${baseUrl}/isletme`, { waitUntil: 'domcontentloaded' });
    await page.locator('#providerLogin button').click();
    await page.locator('#providerWorkspace').waitFor({ state: 'visible' });
    await page.locator('#monadMode').filter({ hasText: 'Monad Testnet bağlı' }).waitFor();

    const prepared = istanbulParts(new Date(Date.now() + 5 * 60_000));
    const deadline = istanbulParts(new Date(Date.now() + 2 * 60 * 60_000));
    await page.locator('#publishForm input[name="businessName"]').fill('Monad Demo Mutfağı');
    await page.locator('#publishForm input[name="title"]').fill(title);
    await page.locator('#publishForm input[name="contents"]').fill('P-256 ile ayrılan doğrulama paketi');
    await page.locator('#publishForm input[name="quantity"]').fill('1');
    await page.locator('#publishForm input[name="pickupDate"]').fill(`${deadline.year}-${deadline.month}-${deadline.day}`);
    await page.locator('#publishForm input[name="preparedAt"]').fill(deadline.day === prepared.day ? `${prepared.hour}:${prepared.minute}` : '00:00');
    await page.locator('#publishForm input[name="deadline"]').fill(`${deadline.hour}:${deadline.minute}`);
    await page.locator('#publishForm input[name="address"]').fill('Kılıçali Paşa Mahallesi, Akarsu Caddesi No:18, Beyoğlu');
    await page.locator('#captureProviderLocation').click();
    await page.locator('#providerLocationState.ready').waitFor();
    await page.locator('#publishForm input[name="safety"]').check();

    const publishResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/publish'));
    await page.locator('#publishForm .publish-button').click();
    const publishResponse = await publishResponsePromise;
    assert.equal(publishResponse.status(), 200, `Publish failed: ${await publishResponse.text()}`);
    const listing = page.locator('.provider-listing-card').filter({ hasText: title });
    await listing.waitFor();
    const publishProof = await listing.locator('a.chain-proof').getAttribute('href');
    assert.match(publishProof, /^https:\/\/testnet\.monadvision\.com\/tx\/0x[0-9a-f]{64}$/i);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#featuredTitle').filter({ hasText: title }).waitFor();
    const claimResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/claim'));
    await page.locator('.claim').click();
    const claimResponse = await claimResponsePromise;
    assert.equal(claimResponse.status(), 200, `Claim failed: ${await claimResponse.text()}`);
    await page.locator('#pickupDialog[open]').waitFor();
    const code = await page.locator('#pickupCode').textContent();
    const claimProof = await page.locator('#pickupChainProof').getAttribute('href');
    assert.match(claimProof, /^https:\/\/testnet\.monadvision\.com\/tx\/0x[0-9a-f]{64}$/i);

    await page.goto(`${baseUrl}/isletme`, { waitUntil: 'domcontentloaded' });
    await page.locator('#providerWorkspace').waitFor({ state: 'visible' });
    await page.locator('#redeemCode').fill(code);
    const redeemResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/redeem'));
    await page.locator('#redeemForm button').click();
    const redeemResponse = await redeemResponsePromise;
    assert.equal(redeemResponse.status(), 200, `Redeem failed: ${await redeemResponse.text()}`);
    await page.locator('#lastRedeemProof').waitFor({ state: 'visible' });
    const redeemProof = await page.locator('#lastRedeemProof').getAttribute('href');
    assert.match(redeemProof, /^https:\/\/testnet\.monadvision\.com\/tx\/0x[0-9a-f]{64}$/i);
    assert.deepEqual(pageErrors, []);

    console.log(JSON.stringify({ title, publishProof, claimProof, redeemProof }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
