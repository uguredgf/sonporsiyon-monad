import { exportDevicePublicKey, getOrCreateDeviceKey, signClaim, signRelease } from './p256-device.js';

const DEVICE_KEY = 'sonporsiyon-device';
const PROVIDER_LOCATION_KEY = 'sonporsiyon-provider-location';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const businessMode = location.pathname.replace(/\/$/, '') === '/isletme';
let state = { batches: [], events: [], claimTtlSeconds: 1800 };
let currentView = 'discover';
let providerAuthenticated = false;
let activeProvider = null;
let userCoords = null;
let pendingBatchId = null;
let packageFingerprint = '';
let providerListingsFingerprint = '';
let lastSuccessfulSyncAt = null;
const ISTANBUL_TIME_ZONE = 'Europe/Istanbul';
const BUSINESS_IMAGES = {
  komsu: { src: '/assets/komsu-firin.jpg', alt: 'Komşu Fırın sandviç paketi' },
  moda: { src: '/assets/moda-yemekhane.jpg', alt: 'Moda Yemekhane sıcak yemek paketi' },
  aksam: { src: '/assets/aksam-kafe.jpg', alt: 'Akşam Kafe fırın ürünü paketi' },
};
const BUSINESS_IMAGE_POOL = Object.values(BUSINESS_IMAGES);
const announcedWallets = [];
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.provider && !announcedWallets.includes(event.detail.provider)) announcedWallets.push(event.detail.provider);
});

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'İşlem tamamlanamadı.');
  return data;
}

async function loadState() {
  state = await request(`/api/state?deviceId=${encodeURIComponent(deviceId())}`);
  lastSuccessfulSyncAt = Date.now();
  setSyncStatus();
  render();
  showNotices(state.notices || []);
}

function allSlots() { return state.batches.flatMap(batch => batch.slots.map((portion, index) => ({ ...portion, batch, index }))); }
function ownClaim() { return allSlots().find(portion => portion.ownerId === deviceId() && portion.state === 'claimed'); }
function expired(batch) { return !batch || Date.now() >= batch.deadlineAt; }
function available(batch) { return batch && !expired(batch) ? batch.slots.filter(item => item.state === 'available').length : 0; }
function radians(value) { return value * Math.PI / 180; }
function distanceKm(batch) {
  if (!userCoords || !Number.isFinite(Number(batch.latitude)) || !Number.isFinite(Number(batch.longitude))) return null;
  const earth = 6371;
  const latDelta = radians(Number(batch.latitude) - userCoords.latitude);
  const lngDelta = radians(Number(batch.longitude) - userCoords.longitude);
  const value = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(userCoords.latitude)) * Math.cos(radians(Number(batch.latitude))) * Math.sin(lngDelta / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function activeBatches() {
  const batches = state.batches.filter(batch => batch.status !== 'cancelled' && !expired(batch));
  return userCoords ? batches.sort((left, right) => (distanceKm(left) ?? Infinity) - (distanceKm(right) ?? Infinity)) : batches;
}
function featuredBatch() { return activeBatches().find(batch => available(batch) > 0) || activeBatches()[0]; }
function formatTime(iso) { return new Intl.DateTimeFormat('tr-TR', { timeZone: ISTANBUL_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function istanbulDay(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ISTANBUL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}
function isToday(timestamp) { return Boolean(timestamp) && istanbulDay(timestamp) === istanbulDay(); }
function holdMinutes(batch) { return Math.max(1, Math.round(Number(batch?.claimTtlSeconds || state.claimTtlSeconds || 1800) / 60)); }
function effectiveHoldSeconds(batch) {
  const remaining = Math.max(0, Math.floor((Number(batch?.deadlineAt) - Date.now()) / 1000));
  return Math.min(holdMinutes(batch) * 60, remaining);
}
function holdLabel(batch) {
  const seconds = effectiveHoldSeconds(batch);
  if (seconds < 60) return 'Teslim için 1 dakikadan az';
  const minutes = Math.floor(seconds / 60);
  return seconds < holdMinutes(batch) * 60 ? `Teslim için en fazla ${minutes} dk` : `Teslim için ${minutes} dk`;
}
function holdShortLabel(batch) {
  const seconds = effectiveHoldSeconds(batch);
  return seconds < 60 ? '<1 DK' : `${Math.floor(seconds / 60)} DK`;
}
function batchImage(batch) {
  if (BUSINESS_IMAGES[batch?.providerId]) return BUSINESS_IMAGES[batch.providerId];
  const identity = String(batch?.providerId || batch?.provider || 'paket');
  const index = [...identity].reduce((total, character) => total + character.codePointAt(0), 0) % BUSINESS_IMAGE_POOL.length;
  return { ...BUSINESS_IMAGE_POOL[index], alt: `${batch?.provider || 'İşletme'} paket görseli` };
}
function hasCoordinates(batch) { return Number.isFinite(Number(batch?.latitude)) && Number.isFinite(Number(batch?.longitude)); }
function mapUrl(batch) { return hasCoordinates(batch) ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(batch.latitude)}&mlon=${encodeURIComponent(batch.longitude)}#map=17/${encodeURIComponent(batch.latitude)}/${encodeURIComponent(batch.longitude)}` : ''; }

function localDateValue(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showNotices(notices) {
  const notice = notices.at(-1);
  if (!notice) return;
  if ($('#pickupDialog').open) $('#pickupDialog').close();
  $('#noticeTitle').textContent = notice.title;
  $('#noticeMessage').textContent = notice.message;
  if (!$('#noticeDialog').open) $('#noticeDialog').showModal();
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

function showView(name, { updateHistory = true, focusHeading = true } = {}) {
  currentView = name;
  $$('.view').forEach(view => { view.hidden = view.id !== `${name}View`; view.classList.toggle('active', !view.hidden); });
  $$('.nav-pill').forEach(button => { const active = button.dataset.view === name; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
  if (updateHistory && !businessMode) {
    const url = new URL(location.href);
    if (name === 'impact') url.searchParams.set('view', 'impact');
    else url.searchParams.delete('view');
    history.pushState({ view: name }, '', `${url.pathname}${url.search}${url.hash}`);
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (focusHeading) window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  const heading = $(`#${name}View h1`);
  if (heading && focusHeading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  if (name === 'provider') checkProviderAuth().catch(() => {});
}

function setSyncStatus(error) {
  const node = $('#syncStatus');
  if (!node) return;
  node.hidden = !error;
  if (!error) { node.textContent = ''; return; }
  const lastUpdate = lastSuccessfulSyncAt ? `${formatTime(lastSuccessfulSyncAt)} son güncelleme` : 'Henüz güncel veri alınamadı';
  node.textContent = `Bağlantı kesildi. ${lastUpdate}; yeniden deneniyor.`;
}

async function checkProviderAuth() {
  const data = await request('/api/provider/status');
  providerAuthenticated = data.authenticated;
  activeProvider = data.provider || null;
  const siteOwnerMode = data.mode === 'site-owner';
  $('#providerLogin').classList.toggle('authenticated', providerAuthenticated);
  $('#providerApplication').hidden = providerAuthenticated || siteOwnerMode;
  $('#providerWorkspace').hidden = !providerAuthenticated;
  $('#providerSession').hidden = !providerAuthenticated;
  $('#providerLogout').hidden = siteOwnerMode;
  const loginButton = $('#providerLogin button');
  loginButton.disabled = siteOwnerMode && !providerAuthenticated;
  if (siteOwnerMode && !providerAuthenticated) {
    loginButton.textContent = 'SİTE SAHİBİ GİRİŞİ GEREKLİ';
    $('#providerAccessMessage').textContent = 'Canlı işletme paneli yalnız doğrulanmış site sahibine açıktır.';
  }
  if (activeProvider) {
    $('#providerBusiness').textContent = activeProvider.name;
    $('#providerWallet').textContent = activeProvider.identityLabel || (activeProvider.wallet ? `${activeProvider.wallet.slice(0, 6)}…${activeProvider.wallet.slice(-4)}` : 'Doğrulanmış işletme');
    $('#providerVerification').textContent = (activeProvider.verificationLabel || 'Kayıt bilgisi eşleştirildi').toLocaleUpperCase('tr-TR');
    const businessName = $('#publishForm').elements.businessName;
    if (businessName.value === 'Mahalle İşletmesi') businessName.value = activeProvider.name;
    renderProviderListings();
  }
}

function hexUtf8(value) {
  return `0x${[...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function findWalletProvider(waitMs = 250) {
  const injected = window.ethereum?.providers?.find(provider => provider.isMetaMask) || window.ethereum?.providers?.[0] || window.ethereum;
  if (injected?.request) return injected;
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  return announcedWallets.find(provider => provider?.request) || null;
}

async function signWalletMessage(wallet, message, address) {
  try {
    return await wallet.request({ method: 'personal_sign', params: [hexUtf8(message), address] });
  } catch (error) {
    if (error.code === 4001) throw error;
    if (![-32601, -32602].includes(Number(error.code)) && !/param|argument|hex/i.test(String(error.message || ''))) throw error;
    return wallet.request({ method: 'personal_sign', params: [message, address] });
  }
}

async function connectedWallet() {
  const wallet = await findWalletProvider();
  if (!wallet) throw new Error('Bu tarayıcıda cüzdan eklentisi yok. Sayfayı MetaMask veya Rabby yüklü Chrome/Edge tarayıcısında aç.');
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  const address = accounts?.[0];
  if (!address) throw new Error('Cüzdan hesabı seçilmedi.');
  return { wallet, address };
}

async function connectProviderWallet() {
  const { wallet, address } = await connectedWallet();
  const challenge = await request(`/api/provider/challenge?purpose=login&address=${encodeURIComponent(address)}`);
  const signature = await signWalletMessage(wallet, challenge.message, address);
  await request('/api/provider/login', { method: 'POST', body: { address, signature } });
  await checkProviderAuth();
}

async function applyAsProvider(form) {
  const { wallet, address } = await connectedWallet();
  const challenge = await request(`/api/provider/challenge?purpose=application&address=${encodeURIComponent(address)}`);
  const signature = await signWalletMessage(wallet, challenge.message, address);
  const fields = Object.fromEntries(new FormData(form));
  return request('/api/provider/apply', { method: 'POST', body: { ...fields, address, signature } });
}

async function logoutProvider() {
  await request('/api/provider/logout', { method: 'POST' });
  await checkProviderAuth();
  toast('İşletme oturumu kapatıldı.');
}

async function claimBatch(batchId) {
  if (pendingBatchId) return;
  const existing = ownClaim();
  if (existing) {
    if (existing.batch.id !== batchId) toast('Önce aktif paketini teslim al veya geri bırak.');
    openPickup(existing); return;
  }
  const batch = state.batches.find(item => item.id === batchId);
  if (!batch) { toast('Henüz yayınlanmış paket yok.'); return; }
  if (expired(batch)) { toast('Bu partinin güvenli teslim süresi kapandı.'); return; }
  pendingBatchId = batchId; render();
  try {
    const body = { deviceId: deviceId(), batchId: batch.id };
    if (state.chain?.enabled && batch.chainBatchId) {
      const keyPair = await getOrCreateDeviceKey();
      const publicKey = await exportDevicePublicKey(keyPair);
      const prepared = await request('/api/claim/prepare', { method: 'POST', body: { ...body, ...publicKey } });
      body.chainProof = { token: prepared.token, ...(await signClaim(keyPair, prepared.claim)) };
    }
    state = await request('/api/claim', { method: 'POST', body });
    render(); openPickup(ownClaim());
  } catch (error) { toast(error.message); await loadState(); }
  finally { pendingBatchId = null; render(); }
}

async function claimFeatured() {
  const batch = featuredBatch();
  if (!batch) { toast('Henüz yayınlanmış paket yok.'); return; }
  return claimBatch(batch.id);
}

function openPickup(portion = ownClaim()) {
  if (!portion) { toast('Aktif teslim kodun bulunmuyor.'); return; }
  $('#pickupCode').textContent = portion.code;
  $('#pickupProduct').textContent = portion.batch.title;
  $('#pickupContents').textContent = portion.batch.contents;
  $('#pickupProvider').textContent = `${portion.batch.provider.toUpperCase()} · ${portion.batch.address}`;
  $('#pickupDirections').hidden = !hasCoordinates(portion.batch);
  $('#pickupDirections').href = mapUrl(portion.batch);
  const proof = $('#pickupChainProof');
  proof.hidden = !portion.claimTxHash;
  proof.href = portion.claimTxHash ? `${String(state.chain?.explorerUrl || '').replace(/\/$/, '')}/tx/${portion.claimTxHash}` : '';
  $('#pickupDeadline').textContent = portion.batch.deadline;
  updateCountdown();
  $('#pickupDialog').showModal();
}

async function releaseOwnClaim() {
  const portion = ownClaim(); if (!portion) return;
  try {
    const body = { deviceId: deviceId(), batchId: portion.batch.id, slotIndex: portion.index };
    if (state.chain?.enabled && portion.claimTxHash) {
      const keyPair = await getOrCreateDeviceKey();
      const publicKey = await exportDevicePublicKey(keyPair);
      const prepared = await request('/api/release/prepare', { method: 'POST', body: { ...body, ...publicKey } });
      body.chainProof = { token: prepared.token, ...(await signRelease(keyPair, prepared.release)) };
    }
    state = await request('/api/release', { method: 'POST', body });
    packageFingerprint = '';
    render(); $('#pickupDialog').close(); toast('Paket geri bırakıldı; tüm paketler yeniden seçilebilir.');
  } catch (error) { toast(error.message); }
}

async function redeem(code) {
  const result = await request('/api/redeem', { method: 'POST', body: { code, deviceId: deviceId() } });
  state = result.state; render();
  const panel = $('#lastCounterEvent');
  panel.querySelector('strong').textContent = `${String(code).trim().toUpperCase()} kapatıldı`;
  panel.querySelector('p').textContent = 'Bu porsiyon ikinci kez kullanılamaz.';
  const proof = $('#lastRedeemProof');
  proof.hidden = !result.redeemed?.txHash;
  proof.href = result.redeemed?.txHash ? `${String(state.chain?.explorerUrl || '').replace(/\/$/, '')}/tx/${result.redeemed.txHash}` : '';
}

async function publish(form) {
  const data = Object.fromEntries(new FormData(form));
  const next = await request('/api/publish', { method: 'POST', body: { ...data, quantity: Number(data.quantity), deviceId: deviceId() } });
  localStorage.setItem(PROVIDER_LOCATION_KEY, JSON.stringify({ address: data.address, latitude: data.latitude, longitude: data.longitude }));
  state = next; render(); toast(`${data.quantity} porsiyonluk paket listesi yayınlandı.`);
}

function browserPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Bu tarayıcı konum özelliğini desteklemiyor.')); return; }
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
      () => reject(new Error('Konum alınamadı. Tarayıcı iznini açıp yeniden dene.')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

async function useUserLocation() {
  const buttons = $$('[data-location-action]');
  try {
    buttons.forEach(button => { button.disabled = true; button.textContent = 'KONUM ALINIYOR…'; });
    userCoords = await browserPosition();
    packageFingerprint = '';
    $('#locationState').textContent = `±${Math.round(userCoords.accuracy)} m doğruluk`;
    $('#locationEyebrow').textContent = 'BUGÜN · KONUMUNA GÖRE';
    render();
  } catch (error) { toast(error.message); }
  finally {
    buttons.forEach(button => { button.disabled = false; button.textContent = userCoords ? 'KONUMU YENİLE' : 'KONUMUMA GÖRE SIRALA'; });
  }
}

async function captureProviderLocation() {
  const button = $('#captureProviderLocation');
  try {
    button.disabled = true; button.textContent = 'KONUM ALINIYOR…';
    const coords = await browserPosition();
    const form = $('#publishForm');
    form.elements.latitude.value = String(coords.latitude);
    form.elements.longitude.value = String(coords.longitude);
    $('#providerLocationState').textContent = `Konum eklendi · yaklaşık ±${Math.round(coords.accuracy)} m doğruluk`;
    $('#providerLocationState').classList.add('ready');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'TESLİM NOKTASININ KONUMUNU YENİLE'; }
}

function updateCountdown() {
  const claim = ownClaim();
  if (!claim?.claimExpiresAt) return;
  const seconds = Math.max(0, Math.ceil((claim.claimExpiresAt - Date.now()) / 1000));
  const label = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('#claimCountdown').textContent = label;
  $('.claim b').textContent = `KALAN ${label}`;
  if (seconds === 0 && $('#pickupDialog').open) loadState().then(() => { if (!ownClaim()) { $('#pickupDialog').close(); toast('Ayırma süren doldu; porsiyon yeniden açıldı.'); } });
}

function providerInitials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toLocaleUpperCase('tr-TR');
}

function fact(label, value) {
  const row = document.createElement('li');
  const key = document.createElement('b'); key.textContent = label;
  const content = document.createElement('span'); content.textContent = value;
  row.append(key, content); return row;
}

function renderPackageGrid(activeClaim) {
  const allBatches = activeBatches();
  const featured = featuredBatch();
  const alternatives = allBatches.filter(batch => batch.id !== featured?.id);
  const batches = alternatives.length ? alternatives : allBatches;
  const fingerprint = JSON.stringify({
    batches: batches.map(batch => [batch.id, available(batch), batch.deadlineAt, batch.claimTtlSeconds, batch.title, batch.contents, batch.address, batch.providerVerified]),
    active: activeClaim?.batch.id || '', pendingBatchId,
    coords: userCoords ? [userCoords.latitude.toFixed(4), userCoords.longitude.toFixed(4)] : null,
  });
  if (fingerprint === packageFingerprint) return;
  const focusedBatch = document.activeElement?.dataset?.claimBatch;
  packageFingerprint = fingerprint;
  if (!batches.length) {
    const empty = document.createElement('p'); empty.className = 'package-empty'; empty.textContent = 'Şu anda teslim süresi açık paket bulunmuyor.';
    $('#packageGrid').replaceChildren(empty); return;
  }
  const cards = batches.map(batch => {
    const remaining = available(batch);
    const card = document.createElement('article'); card.className = `package-card${remaining ? '' : ' sold-out'}`; card.dataset.batchCard = batch.id; card.tabIndex = -1;
    const provider = document.createElement('div'); provider.className = 'package-provider';
    const mark = document.createElement('span'); mark.className = 'provider-mark'; mark.textContent = providerInitials(batch.provider);
    const identity = document.createElement('div');
    const business = document.createElement('strong'); business.textContent = batch.provider;
    const location = document.createElement('span'); location.textContent = batch.address;
    identity.append(business, location);
    const stock = document.createElement('b'); stock.textContent = remaining ? `${remaining} KALDI` : 'TÜKENDİ';
    provider.append(mark, identity, stock);
    const body = document.createElement('div'); body.className = 'package-body';
    const title = document.createElement('h3'); title.textContent = batch.title;
    const facts = document.createElement('ul'); facts.className = 'package-facts';
    const distance = distanceKm(batch);
    facts.append(
      fact('PAKET', batch.contents || 'İçerik bilgisi eksik'),
      fact('TESLİM', `Son teslim ${String(batch.deadline).replace(':', '.')}`),
      fact('AYIRMA', holdLabel(batch)),
      fact('ALERJEN', batch.allergens || 'Bilgi eksik'),
      fact('MESAFE', distance === null ? 'Konumla hesaplanır' : distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`),
    );
    const directions = document.createElement('a'); directions.className = 'card-directions'; directions.href = mapUrl(batch); directions.target = '_blank'; directions.rel = 'noopener'; directions.textContent = hasCoordinates(batch) ? 'HARİTADA AÇ ↗' : 'HARİTA KONUMU EKSİK'; if (!hasCoordinates(batch)) directions.removeAttribute('href');
    const button = document.createElement('button'); button.type = 'button'; button.dataset.claimBatch = batch.id;
    const ownsThis = activeClaim?.batch.id === batch.id;
    const pending = pendingBatchId === batch.id;
    button.disabled = pending || (!ownsThis && (Boolean(activeClaim) || remaining === 0));
    button.setAttribute('aria-busy', pending ? 'true' : 'false');
    button.textContent = pending ? 'AYRILIYOR…' : ownsThis ? 'TESLİM KODUMU GÖSTER' : activeClaim ? 'AKTİF PAKETİNİ TAMAMLA' : remaining ? 'BU PAKETİ AYIR' : 'PAKET KALMADI';
    const actions = document.createElement('div'); actions.className = 'package-actions'; actions.append(directions, button);
    body.append(title, facts, actions); card.append(provider, body); return card;
  });
  $('#packageGrid').replaceChildren(...cards);
  if (focusedBatch) $('#packageGrid').querySelector(`[data-claim-batch="${CSS.escape(focusedBatch)}"]`)?.focus({ preventScroll: true });
}

function focusBatchCard(batchId) {
  let card = $(`[data-batch-card="${CSS.escape(batchId)}"]`);
  if (!card && featuredBatch()?.id === batchId) card = $('.featured');
  if (!card) return;
  card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  card.focus({ preventScroll: true });
  card.classList.remove('batch-highlight');
  requestAnimationFrame(() => card.classList.add('batch-highlight'));
  clearTimeout(focusBatchCard.timer);
  focusBatchCard.timer = setTimeout(() => card.classList.remove('batch-highlight'), 1800);
}

function renderNearby() {
  const plot = $('#nearbyPlot');
  const batches = activeBatches().filter(batch => available(batch) > 0);
  if (!userCoords) {
    const empty = document.createElement('p'); empty.className = 'map-empty'; empty.textContent = 'Konumunu yalnız bu cihazda kullanarak gerçek mesafeleri görebilirsin.';
    plot.replaceChildren(empty);
  } else {
    const mappable = batches.filter(batch => Number.isFinite(Number(batch.latitude)) && Number.isFinite(Number(batch.longitude))).slice(0, 6);
    const latitudeScale = Math.cos(radians(userCoords.latitude));
    const offsets = mappable.map(batch => ({ batch, x: (Number(batch.longitude) - userCoords.longitude) * latitudeScale, y: Number(batch.latitude) - userCoords.latitude }));
    const maxOffset = Math.max(...offsets.flatMap(item => [Math.abs(item.x), Math.abs(item.y)]), 0.002);
    const you = document.createElement('span'); you.className = 'you'; you.textContent = 'sen';
    const positions = [];
    const pins = offsets.map(({ batch, x, y }, index) => {
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = `real-pin pin-${index + 1}`; pin.dataset.focusBatch = batch.id;
      let pinX = Math.max(12, Math.min(80, 50 + x / maxOffset * 34));
      let pinY = Math.max(12, Math.min(68, 50 - y / maxOffset * 28));
      for (let attempt = 0; attempt < 5 && positions.some(item => Math.hypot(pinX - item.x, pinY - item.y) < 18); attempt += 1) {
        const angle = (index * 137.5 + attempt * 72) * Math.PI / 180;
        pinX = Math.max(12, Math.min(80, pinX + Math.cos(angle) * 19));
        pinY = Math.max(12, Math.min(68, pinY + Math.sin(angle) * 19));
      }
      positions.push({ x: pinX, y: pinY });
      pin.style.setProperty('--x', `${pinX}%`);
      pin.style.setProperty('--y', `${pinY}%`);
      pin.title = `${batch.provider} · ${distanceKm(batch)?.toFixed(1)} km`;
      pin.setAttribute('aria-label', `${batch.provider} paketini göster`);
      const count = document.createElement('b'); count.textContent = available(batch); pin.append(count); return pin;
    });
    plot.replaceChildren(you, ...pins);
  }
  const feed = batches.slice(0, 3).map(batch => {
    const row = document.createElement('li');
    const point = document.createElement('button'); point.type = 'button'; point.className = 'network-point'; point.dataset.focusBatch = batch.id;
    const dot = document.createElement('i');
    const name = document.createElement('span'); name.textContent = batch.provider;
    const distance = distanceKm(batch);
    const detail = document.createElement('b'); detail.textContent = distance === null ? `${available(batch)} paket` : `${distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`} · ${available(batch)} paket`;
    point.append(dot, name, detail); row.append(point); return row;
  });
  $('.network-feed').replaceChildren(...feed);
}

function renderProviderListings() {
  const host = $('#providerListings');
  if (!host || !providerAuthenticated || !activeProvider) { providerListingsFingerprint = ''; return; }
  const owned = state.batches.filter(batch => batch.providerId === activeProvider.id).sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
  const fingerprint = JSON.stringify([activeProvider.id, owned.map(batch => [batch.id, batch.status, batch.cancelReason, batch.title, batch.deadline, batch.claimTtlSeconds, batch.slots.map(slot => slot.state)])]);
  if (fingerprint === providerListingsFingerprint) return;
  const drafts = new Map([...host.querySelectorAll('[data-cancel-note]')].map(input => {
    const id = input.dataset.cancelNote;
    return [id, { note: input.value, reason: host.querySelector(`[data-cancel-reason="${CSS.escape(id)}"]`)?.value || '' }];
  }));
  const focused = document.activeElement?.dataset?.cancelNote
    ? `[data-cancel-note="${CSS.escape(document.activeElement.dataset.cancelNote)}"]`
    : document.activeElement?.dataset?.cancelReason ? `[data-cancel-reason="${CSS.escape(document.activeElement.dataset.cancelReason)}"]` : '';
  providerListingsFingerprint = fingerprint;
  if (!owned.length) {
    const empty = document.createElement('p'); empty.className = 'provider-listing-empty'; empty.textContent = 'Henüz bu cüzdanla yayınlanmış paket yok.';
    host.replaceChildren(empty); return;
  }
  const cards = owned.map(batch => {
    const closed = batch.status === 'cancelled';
    const card = document.createElement('article'); card.className = `provider-listing-card${closed ? ' closed' : ''}`;
    const head = document.createElement('div'); head.className = 'listing-card-head';
    const text = document.createElement('div');
    const status = document.createElement('span'); status.textContent = closed ? 'KAPATILDI' : `${available(batch)} ALINABİLİR`;
    const title = document.createElement('h3'); title.textContent = batch.title;
    const meta = document.createElement('p'); meta.textContent = closed ? batch.cancelReason || 'İşletme tarafından kapatıldı' : `${batch.slots.length} porsiyon · ${batch.deadline} son teslim${batch.chainCreateTxHash ? ' · Monad kanıtlı' : ''}`;
    text.append(title, meta);
    if (batch.chainCreateTxHash) {
      const proof = document.createElement('a'); proof.className = 'directions-link chain-proof'; proof.target = '_blank'; proof.rel = 'noopener'; proof.textContent = 'MONAD YAYIN İŞLEMİNİ AÇ ↗';
      proof.href = `${String(state.chain?.explorerUrl || '').replace(/\/$/, '')}/tx/${batch.chainCreateTxHash}`;
      text.append(proof);
    }
    head.append(text, status);
    const actions = document.createElement('div'); actions.className = 'listing-controls';
    const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.editBatch = batch.id; edit.textContent = 'DÜZENLE'; edit.disabled = closed;
    const reason = document.createElement('select'); reason.dataset.cancelReason = batch.id; reason.disabled = closed; reason.setAttribute('aria-label', 'Yayını kapatma nedeni');
    for (const label of ['Erken tükendi', 'İmha edildi', 'Yayın hatası']) { const option = document.createElement('option'); option.value = label; option.textContent = label; reason.append(option); }
    const draft = drafts.get(batch.id);
    if (draft?.reason) reason.value = draft.reason;
    const note = document.createElement('input'); note.dataset.cancelNote = batch.id; note.disabled = closed; note.maxLength = 140; note.placeholder = 'Kullanıcıya gösterilecek kısa not'; note.setAttribute('aria-label', 'Kapatma notu'); note.value = draft?.note || '';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.cancelBatch = batch.id; cancel.className = 'danger'; cancel.textContent = closed ? 'YAYIN KAPALI' : 'YAYINI KAPAT'; cancel.disabled = closed;
    actions.append(edit, reason, note, cancel); card.append(head, actions); return card;
  });
  host.replaceChildren(...cards);
  if (focused) host.querySelector(focused)?.focus({ preventScroll: true });
}

function openBatchEditor(batchId) {
  const batch = state.batches.find(item => item.id === batchId);
  if (!batch || batch.status === 'cancelled') return;
  const form = $('#batchEditForm');
  form.elements.batchId.value = batch.id;
  form.elements.title.value = batch.title;
  form.elements.contents.value = batch.contents;
  form.elements.quantity.value = batch.slots.length;
  form.elements.pickupDate.value = localDateValue(batch.deadlineAt);
  form.elements.deadline.value = batch.deadline;
  form.elements.claimTtlMinutes.value = String(holdMinutes(batch));
  form.elements.allergens.value = batch.allergens || '';
  $('#batchEditDialog').showModal();
}

async function updatePublishedBatch(form) {
  const fields = Object.fromEntries(new FormData(form));
  state = await request('/api/batch/update', { method: 'POST', body: { ...fields, quantity: Number(fields.quantity), deviceId: deviceId() } });
  render(); $('#batchEditDialog').close(); toast('Yayın güncellendi.');
}

async function closePublishedBatch(batchId) {
  const reason = $(`[data-cancel-reason="${CSS.escape(batchId)}"]`).value;
  const note = $(`[data-cancel-note="${CSS.escape(batchId)}"]`).value.trim();
  if (!note) { toast('Kullanıcıya gösterilecek kısa bir kapatma notu yaz.'); return; }
  if (!confirm(`“${reason}” nedeniyle bu yayını kapatmak istiyor musun? Aktif teslim kodları iptal edilecek.`)) return;
  state = await request('/api/batch/cancel', { method: 'POST', body: { batchId, reason, note, deviceId: deviceId() } });
  render(); toast('Yayın kapatıldı; etkilenen kullanıcılara bilgi verildi.');
}

function render() {
  const slots = allSlots();
  const counts = status => slots.filter(item => item.state === status).length;
  const totalAvailable = state.batches.reduce((total, batch) => total + available(batch), 0);
  const availableBatches = activeBatches().filter(batch => available(batch) > 0);
  const locationCount = new Set(availableBatches.map(batch => `${batch.provider}|${batch.address}`)).size;
  const todayEvents = state.events.filter(item => isToday(item.at));
  const featured = featuredBatch();
  const featuredAvailable = available(featured);
  const claim = ownClaim();
  renderPackageGrid(claim);
  renderNearby();
  renderProviderListings();

  if ($('#pickupDialog').open && !claim) {
    $('#pickupDialog').close();
    toast('Teslim kodu artık aktif değil; ortak durum güncellendi.');
  }

  if (!featured) {
    $('.featured').removeAttribute('data-batch-card');
    $('.featured').removeAttribute('tabindex');
    $('.featured-overlay strong').textContent = 'Henüz paket yok';
    $('.featured-overlay span').textContent = 'YAKININDA YENİ PAKET YOK';
    $('#featuredProvider').textContent = 'YAYIN BEKLENİYOR';
    $('.featured .provider-name i').textContent = 'GÜNCEL STOK';
    $('#featuredTitle').textContent = 'Yeni paketler yayınlandığında burada görünecek';
    $('#featuredMeta').textContent = 'Daha sonra yeniden kontrol edebilirsin.';
    $('.claim').disabled = true;
    $('.claim span').textContent = 'Henüz paket yok';
  } else {
    const image = batchImage(featured);
    if ($('#featuredImage').getAttribute('src') !== image.src) $('#featuredImage').src = image.src;
    $('#featuredImage').alt = image.alt;
    $('.featured').dataset.batchCard = featured.id;
    $('.featured').tabIndex = -1;
    $('.featured-overlay strong').textContent = expired(featured) ? 'Teslim süresi kapandı' : `${featuredAvailable} paket kaldı`;
    $('.featured-overlay span').textContent = featured.address.toUpperCase();
    $('#featuredProvider').textContent = featured.provider.toUpperCase();
    $('.featured .provider-name i').textContent = 'YEREL SAĞLAYICI';
    $('#featuredTitle').textContent = featured.title;
    const distance = distanceKm(featured);
    $('#featuredMeta').textContent = `${featured.contents} · Son teslim ${String(featured.deadline).replace(':', '.')}${distance === null ? '' : ` · ${distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`}`}`;
    $('.claim').dataset.batchId = featured.id;
    $('.claim').disabled = Boolean(pendingBatchId) || (!claim && (featuredAvailable === 0 || expired(featured)));
    $('.claim').setAttribute('aria-busy', pendingBatchId === featured.id ? 'true' : 'false');
    $('.claim span').textContent = pendingBatchId === featured.id ? 'Ayırılıyor…' : claim ? 'Teslim kodumu göster' : expired(featured) ? 'Teslim süresi kapandı' : featuredAvailable ? '1 porsiyon ayır' : 'Paket kalmadı';
    $('.claim b').textContent = claim ? 'KALAN SÜRE' : `AYIRINCA ${holdShortLabel(featured)}`;
  }
  $('.pulse strong').textContent = totalAvailable;
  $('#availabilityScope').innerHTML = userCoords ? 'yakınında<br>uygun porsiyon' : 'İstanbul’da<br>uygun porsiyon';
  const summary = `${availableBatches.some(batch => batch.sample) ? 'Demo verisi dahil · ' : ''}Şu anda ${locationCount} teslim noktasında ${totalAvailable} ücretsiz porsiyon var.`;
  if ($('#networkSummary').textContent !== summary) $('#networkSummary').textContent = summary;
  $('#myPickup span').textContent = claim ? '1' : '0';
  $('#mobilePickup').hidden = !claim;
  const monadMode = $('#monadMode');
  if (monadMode) monadMode.textContent = state.chain?.enabled
    ? 'Monad Testnet bağlı: yayın, cihaz ayırması ve teslim kontrata yazılır.'
    : 'Yerel demo: cüzdan imzası oturumu açar; zincir işlemleri testnet anahtarları tanımlanınca etkinleşir.';
  $('#publishedMetric').textContent = state.batches.filter(batch => batch.status !== 'cancelled' && isToday(batch.publishedAt)).reduce((total, batch) => total + batch.slots.length, 0);
  $('#claimedMetric').textContent = counts('claimed');
  $('#redeemedMetric').textContent = state.metrics?.redeemedToday ?? todayEvents.filter(item => item.type === 'redeemed').length;
  $('#releasedMetric').textContent = state.metrics?.releasedToday ?? todayEvents.filter(item => item.type === 'released').length;

  const latestBatch = activeProvider ? state.batches.find(batch => batch.providerId === activeProvider.id) : state.batches[0];
  $('#batchSlots').replaceChildren(...(latestBatch?.slots || []).map((portion, index) => {
    const node = document.createElement('i'); node.className = portion.state; node.textContent = index + 1; node.title = `${index + 1}. porsiyon: ${portion.state}`; return node;
  }));
  const events = [...todayEvents].reverse().slice(0, 9).map(item => {
    const row = document.createElement('li'); row.innerHTML = '<time></time><span></span><b></b>';
    row.querySelector('time').textContent = formatTime(item.at); row.querySelector('span').textContent = item.text; row.querySelector('b').textContent = item.ref; return row;
  });
  if (!events.length) {
    const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = 'Bugün henüz ağ işlemi yok.'; events.push(empty);
  }
  $('#eventLedger').replaceChildren(...events);
  updateCountdown();
}

$$('.nav-pill[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('.claim').addEventListener('click', () => claimFeatured());
$('#packageGrid').addEventListener('click', eventObject => {
  const button = eventObject.target.closest('[data-claim-batch]');
  if (button) claimBatch(button.dataset.claimBatch);
});
$('#nearbyPlot').addEventListener('click', eventObject => {
  const target = eventObject.target.closest('[data-focus-batch]');
  if (target) focusBatchCard(target.dataset.focusBatch);
});
$('.network-feed').addEventListener('click', eventObject => {
  const target = eventObject.target.closest('[data-focus-batch]');
  if (target) focusBatchCard(target.dataset.focusBatch);
});
$('#myPickup').addEventListener('click', () => openPickup());
$('#mobilePickup').addEventListener('click', () => openPickup());
$('#releaseClaim').addEventListener('click', () => releaseOwnClaim());
$('#publishForm').addEventListener('submit', async eventObject => { eventObject.preventDefault(); try { await publish(eventObject.currentTarget); } catch (error) { toast(error.message); } });
$('#redeemForm').addEventListener('submit', async eventObject => { eventObject.preventDefault(); try { await redeem($('#redeemCode').value); toast('Teslim tamamlandı.'); $('#redeemCode').value = ''; } catch (error) { toast(error.message); } });
$('#providerLogin').addEventListener('submit', async eventObject => {
  eventObject.preventDefault();
  const button = eventObject.currentTarget.querySelector('button');
  try {
    button.disabled = true; button.textContent = 'CÜZDANDA İMZALA…';
    await connectProviderWallet();
    $('#providerAccessMessage').textContent = '';
    toast('İşletme cüzdanı doğrulandı.');
  } catch (error) {
    const message = error.code === 4001 ? 'Cüzdan isteği iptal edildi.' : error.message;
    $('#providerAccessMessage').textContent = message;
    if (/başvuru/i.test(message)) $('#providerApplication').open = true;
    toast(message);
    queueMicrotask(() => button.focus());
  }
  finally { button.disabled = false; button.textContent = 'MONAD CÜZDANINI BAĞLA'; }
});
$('#providerApplicationForm').addEventListener('submit', async eventObject => {
  eventObject.preventDefault();
  const form = eventObject.currentTarget;
  const button = form.querySelector('button');
  const status = $('#providerApplicationStatus');
  try {
    button.disabled = true; button.textContent = 'CÜZDANDA İMZALA…';
    const result = await applyAsProvider(form);
    status.textContent = result.message; status.classList.add('success');
    await checkProviderAuth();
    $('#providerWorkspace').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    toast('İşletme panelin açıldı.');
  } catch (error) {
    const message = error.code === 4001 ? 'Cüzdan isteği iptal edildi.' : error.message;
    status.textContent = message; status.classList.remove('success'); toast(message);
    queueMicrotask(() => button.focus());
  } finally { button.disabled = false; button.textContent = 'CÜZDANLA İMZALA VE BAŞVUR'; }
});
$('#providerLogout').addEventListener('click', () => logoutProvider().catch(error => toast(error.message)));
$('#providerListings').addEventListener('click', eventObject => {
  const edit = eventObject.target.closest('[data-edit-batch]');
  const cancel = eventObject.target.closest('[data-cancel-batch]');
  if (edit) openBatchEditor(edit.dataset.editBatch);
  if (cancel) closePublishedBatch(cancel.dataset.cancelBatch).catch(error => toast(error.message));
});
$('#batchEditForm').addEventListener('submit', eventObject => { eventObject.preventDefault(); updatePublishedBatch(eventObject.currentTarget).catch(error => toast(error.message)); });
$$('[data-location-action]').forEach(button => button.addEventListener('click', () => useUserLocation()));
$('#captureProviderLocation').addEventListener('click', () => captureProviderLocation());
$$('[data-view-link]').forEach(link => link.addEventListener('click', eventObject => { eventObject.preventDefault(); showView(link.dataset.viewLink); }));
$$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));

async function registerWebMcp() {
  const context = document.modelContext; if (!context?.registerTool) return;
  await context.registerTool({ name: 'reserve_surplus_portion', title: 'Ücretsiz paketi ayır', description: 'Öne çıkan gün sonu paketinden bu cihaz için bir porsiyon ayırır.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: async () => { await claimFeatured(); const portion = ownClaim(); return { reserved: Boolean(portion), pickupCode: portion?.code, provider: portion?.batch.provider }; } });
}

async function initialize() {
  document.body.classList.toggle('business-mode', businessMode);
  const form = $('#publishForm');
  try {
    const savedLocation = JSON.parse(localStorage.getItem(PROVIDER_LOCATION_KEY) || 'null');
    if (savedLocation?.address && savedLocation?.latitude && savedLocation?.longitude) {
      form.elements.address.value = savedLocation.address;
      form.elements.latitude.value = savedLocation.latitude;
      form.elements.longitude.value = savedLocation.longitude;
      $('#providerLocationState').textContent = 'Daha önce kullanılan teslim noktası hazır.';
      $('#providerLocationState').classList.add('ready');
    }
  } catch { localStorage.removeItem(PROVIDER_LOCATION_KEY); }
  const today = new Date();
  form.elements.pickupDate.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  form.elements.preparedAt.value = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  const future = new Date(Date.now() + 90 * 60_000);
  form.elements.deadline.value = `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`;
  if (businessMode) showView('provider', { updateHistory: false, focusHeading: false });
  else {
    const requestedView = new URLSearchParams(location.search).get('view') === 'impact' ? 'impact' : 'discover';
    showView(requestedView, { updateHistory: false, focusHeading: false });
  }
  if (businessMode && !(await findWalletProvider(350))) {
    $('#providerAccessMessage').textContent = 'Bu tarayıcı cüzdan eklentisi sunmuyor. Giriş için bu adresi MetaMask veya Rabby yüklü Chrome/Edge’de aç.';
  }
  setInterval(() => loadState().catch(error => setSyncStatus(error)), 1000);
  setInterval(updateCountdown, 500);
  const [sharedResult] = await Promise.allSettled([loadState()]);
  if (sharedResult.status === 'rejected') {
    state = { batches: [], events: [], claimTtlSeconds: 1800 };
    render();
    setSyncStatus(sharedResult.reason);
    toast('Paketlere ulaşılamadı; yeniden deneniyor.');
  }
  registerWebMcp().catch(() => {});
  if (window.ethereum?.on) window.ethereum.on('accountsChanged', () => {
    if (providerAuthenticated) logoutProvider().catch(() => {});
  });
}

window.addEventListener('popstate', () => {
  if (!businessMode) showView(new URLSearchParams(location.search).get('view') === 'impact' ? 'impact' : 'discover', { updateHistory: false });
});

initialize().catch(error => { state = { batches: [], events: [], claimTtlSeconds: 1800 }; render(); setSyncStatus(error); toast(error.message); });
