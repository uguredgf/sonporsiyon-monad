import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage } from 'ethers';
import { createMonadBridge } from './lib/monad-bridge.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const port = Number(process.env.PORT || 4177);
const defaultClaimTtlSeconds = Math.round(Number(process.env.CLAIM_TTL_MS || 1_800_000) / 1000);
const claimTtlOptions = new Set([15, 30, 45, 60]);
const hackathonMode = process.env.HACKATHON_MODE !== '0';
const authChallenges = new Map();
const providerSessions = new Map();
const providerApplications = new Map();
const deviceNotices = new Map();
const providerProfiles = readProviderProfiles();
const monad = createMonadBridge();
const pendingChainClaims = new Map();
const pendingChainReleases = new Map();
const allowed = new Set(['index.html', 'styles.css', 'app.js', 'p256-device.js', 'assets/komsu-firin.jpg', 'assets/moda-yemekhane.jpg', 'assets/aksam-kafe.jpg']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

function readProviderProfiles() {
  try {
    const parsed = JSON.parse(process.env.PROVIDER_WALLETS_JSON || '{}');
    return new Map(Object.entries(parsed).map(([address, profile]) => [getAddress(address).toLowerCase(), profile]));
  } catch { throw new Error('PROVIDER_WALLETS_JSON geçerli bir adres/profil nesnesi olmalı.'); }
}

function providerForAddress(address) {
  const checksum = getAddress(address);
  const configured = providerProfiles.get(checksum.toLowerCase());
  const short = `${checksum.slice(0, 6)}…${checksum.slice(-4)}`;
  const verified = Boolean(configured?.registrationNumber && configured?.verifiedAt) && configured.status !== 'suspended';
  return {
    id: configured?.id || `wallet:${checksum.toLowerCase()}`,
    name: configured?.name || `İşletme ${short}`,
    location: configured?.location || 'Cüzdan doğrulamalı teslim noktası',
    wallet: checksum,
    verificationLabel: verified ? 'Kayıt bilgisi eşleştirildi' : 'Cüzdan doğrulandı',
    verified,
    approved: configured?.status !== 'suspended' && (hackathonMode || verified),
  };
}

function cookieValue(req, name) {
  const part = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}

function providerSession(req) {
  const token = cookieValue(req, 'sp_provider');
  const session = providerSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) { if (token) providerSessions.delete(token); return null; }
  return session.provider;
}

function challengeKey(purpose, address) { return `${purpose}:${getAddress(address).toLowerCase()}`; }

function providerChallenge(address, purpose = 'login') {
  const checksum = getAddress(address);
  if (!['login', 'application'].includes(purpose)) throw Object.assign(new Error('Geçersiz imza amacı.'), { status: 400 });
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 5 * 60_000;
  const message = [
    purpose === 'application' ? 'SonPorsiyon işletme doğrulama başvurusu' : 'SonPorsiyon işletme girişi',
    '',
    `Cüzdan: ${checksum}`,
    'Amaç: SonPorsiyon işletme oturumu',
    `Tek kullanımlık kod: ${nonce}`,
    `Son geçerlilik: ${new Date(expiresAt).toISOString()}`,
    '',
    'Bu imza ücretsizdir ve blockchain işlemi oluşturmaz.',
  ].join('\n');
  authChallenges.set(challengeKey(purpose, checksum), { message, expiresAt });
  return { address: checksum, message, expiresAt, chainId: 10143, purpose };
}

const slot = (state = 'available') => ({ state, code: null, ownerId: null, claimExpiresAt: null });
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const safeTime = minutes => {
  const date = new Date(Date.now() + minutes * 60_000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const claimTtlSecondsFor = body => {
  const minutes = Number(body.claimTtlMinutes || 30);
  if (!claimTtlOptions.has(minutes)) throw Object.assign(new Error('Ayırma süresi 15, 30, 45 veya 60 dakika olmalı.'), { status: 400 });
  return minutes * 60;
};
const istanbulTimestamp = (date, time) => new Date(`${date}T${time}:00+03:00`).getTime();
const istanbulDayBounds = () => {
  const day = new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 10);
  const start = istanbulTimestamp(day, '00:00');
  return [start, start + 24 * 60 * 60_000];
};

function seededState() {
  return {
    batches: [
      { id: 'firin', sample: true, providerId: 'komsu', provider: 'Komşu Fırın', providerVerified: true, status: 'active', claimTtlSeconds: 1800, title: 'Sandviç + ekmek paketi', contents: '1 peynirli sandviç ve 1 ekşi maya ekmek', deadline: safeTime(90), deadlineAt: Date.now() + 90 * 60_000, preparedAt: safeTime(-45), storage: 'Oda sıcaklığında kapalı paket', allergens: 'Gluten ve süt ürünü içerir', address: 'Kılıçali Paşa Mah., Akarsu Cd. No:18, Beyoğlu', latitude: 41.03261, longitude: 28.98311, publishedAt: ago(41), slots: [...Array(9)].map(() => slot()) },
      { id: 'moda', sample: true, providerId: 'moda', provider: 'Moda Yemekhane', providerVerified: true, status: 'active', claimTtlSeconds: 3600, title: 'Sıcak tabak paketi', contents: 'Mercimek çorbası, sebzeli bulgur ve yoğurt', deadline: safeTime(70), deadlineAt: Date.now() + 70 * 60_000, preparedAt: safeTime(-30), storage: 'Sıcak muhafaza', allergens: 'Süt ürünü içerir', address: 'Caferağa Mah., Moda Cd. No:44, Kadıköy', latitude: 40.98192, longitude: 29.02668, publishedAt: ago(35), slots: [...Array(5)].map(() => slot()) },
      { id: 'aksam', sample: true, providerId: 'aksam', provider: 'Akşam Kafe', providerVerified: true, status: 'active', claimTtlSeconds: 2700, title: 'Poğaça + meyve paketi', contents: '2 peynirli poğaça ve 1 mevsim meyvesi', deadline: safeTime(110), deadlineAt: Date.now() + 110 * 60_000, preparedAt: safeTime(-25), storage: 'Oda sıcaklığında kapalı paket', allergens: 'Gluten, süt ürünü ve yumurta içerir', address: 'Katip Mustafa Çelebi Mah., Sıraselviler Cd. No:35, Beyoğlu', latitude: 41.03554, longitude: 28.98462, publishedAt: ago(23), slots: [...Array(4)].map(() => slot()) },
    ],
    events: [
      { type: 'published', text: 'Komşu Fırın 9 porsiyon yayınladı', at: ago(41), ref: 'YAYIN' },
      { type: 'published', text: 'Moda Yemekhane 5 porsiyon yayınladı', at: ago(35), ref: 'YAYIN' },
      { type: 'published', text: 'Akşam Kafe 4 porsiyon yayınladı', at: ago(23), ref: 'YAYIN' },
    ],
  };
}

let state = seededState();
const code = () => `SP-${randomBytes(2).toString('hex').toUpperCase()}`;
const event = (type, text, ref) => state.events.push({ type, text, ref, at: new Date().toISOString() });

function refreshExpiries() {
  const now = Date.now();
  for (const batch of state.batches) for (let index = 0; index < batch.slots.length; index += 1) {
    const portion = batch.slots[index];
    if (portion.state === 'claimed' && portion.claimExpiresAt <= now) {
      batch.slots[index] = slot();
      event('released', `${batch.provider} için ayrılan porsiyonun süresi doldu`, `SLOT ${index + 1} / OTOMATİK`);
    }
  }
}

function publicState(deviceId = '') {
  refreshExpiries();
  const [todayStart, tomorrowStart] = istanbulDayBounds();
  const todayEvents = state.events.filter(item => {
    const timestamp = new Date(item.at).getTime();
    return timestamp >= todayStart && timestamp < tomorrowStart;
  });
  const notices = deviceId ? (deviceNotices.get(deviceId) || []) : [];
  if (deviceId && notices.length) deviceNotices.delete(deviceId);
  return {
    claimTtlSeconds: defaultClaimTtlSeconds,
    shared: true,
    chain: monad.status(),
    metrics: {
      redeemedToday: todayEvents.filter(item => item.type === 'redeemed').length,
      releasedToday: todayEvents.filter(item => item.type === 'released').length,
    },
    batches: state.batches.map(batch => ({ ...batch, slots: batch.slots.map(portion => ({
      state: portion.state,
      ownerId: portion.ownerId === deviceId ? deviceId : null,
      code: portion.ownerId === deviceId ? portion.code : null,
      claimExpiresAt: portion.ownerId === deviceId ? portion.claimExpiresAt : null,
      claimTxHash: portion.ownerId === deviceId ? portion.claimTxHash || null : null,
    })) })),
    events: state.events,
    notices,
  };
}

function findBatch(id) { return state.batches.find(batch => batch.id === id); }

function claimCandidate(deviceId, batchId) {
  refreshExpiries();
  const batch = findBatch(batchId);
  if (!batch) throw Object.assign(new Error('Parti bulunamadı.'), { status: 404 });
  if (batch.status === 'cancelled') throw Object.assign(new Error(`Bu yayın kapatıldı: ${batch.cancelReason || 'işletme tarafından kaldırıldı'}`), { status: 409 });
  if (Date.now() >= batch.deadlineAt) throw Object.assign(new Error('Bu partinin güvenli teslim süresi kapandı.'), { status: 409 });
  if (state.batches.some(item => item.slots.some(portion => portion.ownerId === deviceId && portion.state === 'claimed'))) throw Object.assign(new Error('Zaten aktif bir paketin var. Önce onu teslim al veya geri bırak.'), { status: 409 });
  const index = batch.slots.findIndex(portion => portion.state === 'available');
  if (index < 0) throw Object.assign(new Error('Bu partide alınabilir paket kalmadı.'), { status: 409 });
  return { batch, index };
}

function claim(deviceId, batchId, chainClaim = null) {
  const { batch, index } = claimCandidate(deviceId, batchId);
  if (chainClaim && chainClaim.slotIndex !== index) throw Object.assign(new Error('Porsiyon durumu değişti; yeniden dene.'), { status: 409 });
  batch.slots[index] = {
    state: 'claimed', ownerId: deviceId, code: code(), claimExpiresAt: Math.min(Date.now() + batch.claimTtlSeconds * 1000, batch.deadlineAt),
    chainSecret: chainClaim?.secret || null, claimTxHash: chainClaim?.txHash || null,
  };
  event('claimed', `${batch.provider} paketinden bir porsiyon ayrıldı`, chainClaim ? `MONAD / ${chainClaim.txHash.slice(2, 10).toUpperCase()}` : `SLOT ${index + 1}`);
}

function release(deviceId, batchId, slotIndex, chainRelease = null) {
  const batch = findBatch(batchId); const portion = batch?.slots[slotIndex];
  if (!portion || portion.state !== 'claimed' || portion.ownerId !== deviceId) throw Object.assign(new Error('Aktif ayırma bulunamadı.'), { status: 409 });
  batch.slots[slotIndex] = slot();
  event('released', `${batch.provider} için ayrılan porsiyon geri bırakıldı`, chainRelease ? `MONAD / ${chainRelease.txHash.slice(2, 10).toUpperCase()}` : `SLOT ${slotIndex + 1}`);
}

async function prepareChainClaim(body) {
  if (!monad.enabled) throw Object.assign(new Error('Monad testnet köprüsü etkin değil.'), { status: 409 });
  if (!/^0x[0-9a-f]{64}$/i.test(String(body.qx || '')) || !/^0x[0-9a-f]{64}$/i.test(String(body.qy || ''))) throw Object.assign(new Error('Cihaz anahtarı geçersiz.'), { status: 400 });
  const { batch, index } = claimCandidate(body.deviceId, body.batchId);
  if (!batch.chainBatchId) throw Object.assign(new Error('Bu demo paketi zincire bağlı değil.'), { status: 409 });
  const prepared = await monad.prepareClaim({ chainBatchId: batch.chainBatchId, slotIndex: index, qx: body.qx, qy: body.qy });
  const token = randomBytes(24).toString('hex');
  pendingChainClaims.set(token, { ...prepared, deviceId: body.deviceId, batchId: batch.id, slotIndex: index, expiresAt: Date.now() + 5 * 60_000 });
  return { token, claim: prepared.claim };
}

async function prepareChainRelease(body) {
  if (!monad.enabled) throw Object.assign(new Error('Monad testnet köprüsü etkin değil.'), { status: 409 });
  if (!/^0x[0-9a-f]{64}$/i.test(String(body.qx || '')) || !/^0x[0-9a-f]{64}$/i.test(String(body.qy || ''))) throw Object.assign(new Error('Cihaz anahtarı geçersiz.'), { status: 400 });
  const batch = findBatch(body.batchId); const portion = batch?.slots[Number(body.slotIndex)];
  if (!batch?.chainBatchId || !portion?.claimTxHash || portion.state !== 'claimed' || portion.ownerId !== body.deviceId) throw Object.assign(new Error('Zincire bağlı aktif ayırma bulunamadı.'), { status: 409 });
  const release = await monad.prepareRelease({ chainBatchId: batch.chainBatchId, slotIndex: Number(body.slotIndex), qx: body.qx, qy: body.qy });
  const token = randomBytes(24).toString('hex');
  pendingChainReleases.set(token, { release, deviceId: body.deviceId, batchId: batch.id, slotIndex: Number(body.slotIndex), expiresAt: Date.now() + 5 * 60_000 });
  return { token, release };
}

async function redeem(inputCode, providerId) {
  refreshExpiries();
  const normalized = String(inputCode).trim().toUpperCase();
  for (const batch of state.batches.filter(item => item.providerId === providerId)) {
    const index = batch.slots.findIndex(portion => portion.state === 'claimed' && portion.code === normalized);
    if (index >= 0) {
      if (Date.now() >= batch.deadlineAt) throw Object.assign(new Error('Güvenli teslim süresi kapandı; kod kullanılamaz.'), { status: 409 });
      const chainResult = batch.chainBatchId && batch.slots[index].chainSecret ? await monad.redeem({ chainBatchId: batch.chainBatchId, slotIndex: index, secret: batch.slots[index].chainSecret }) : null;
      batch.slots[index] = { ...batch.slots[index], state: 'redeemed', claimExpiresAt: null };
      event('redeemed', `${batch.provider} · ${batch.title} teslim koduyla kapatıldı`, chainResult ? `MONAD / ${chainResult.txHash.slice(2, 10).toUpperCase()}` : `SLOT ${index + 1}`);
      return { batch, index, chainResult };
    }
  }
  throw Object.assign(new Error('Kod aktif değil, süresi doldu veya bu sağlayıcıya ait değil.'), { status: 409 });
}

async function publish(body, provider) {
  const quantity = Number(body.quantity);
  const claimTtlSeconds = claimTtlSecondsFor(body);
  const latitude = Number(body.latitude); const longitude = Number(body.longitude);
  const declaredProviderName = String(body.businessName || '').trim().slice(0, 70);
  const preparedAt = String(body.preparedAt || '').trim();
  if (!body.title || !body.contents || !body.address || (!provider.verified && declaredProviderName.length < 3) || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) throw Object.assign(new Error('İşletme adı, paket, içerik ve teslim adresi bilgileri gerekli.'), { status: 400 });
  if (body.latitude === '' || body.longitude === '' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw Object.assign(new Error('Teslim noktasının harita konumunu ekle.'), { status: 400 });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preparedAt) || preparedAt > body.deadline) throw Object.assign(new Error('Hazırlanma saati son teslim saatinden sonra olamaz.'), { status: 400 });
  const deadlineAt = istanbulTimestamp(body.pickupDate, body.deadline);
  const batch = {
    id: `batch-${Date.now().toString(36)}`, providerId: provider.id, provider: provider.verified ? provider.name : declaredProviderName, providerVerified: provider.verified, status: 'active', sample: false,
    title: String(body.title).slice(0, 50), contents: String(body.contents).slice(0, 140), deadline: body.deadline, deadlineAt, preparedAt,
    storage: String(body.storage || 'Oda sıcaklığında kapalı paket').slice(0, 80), allergens: String(body.allergens).slice(0, 90),
    address: String(body.address).slice(0, 160), latitude, longitude, claimTtlSeconds, publishedAt: new Date().toISOString(), slots: [...Array(quantity)].map(() => slot()),
  };
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw Object.assign(new Error('Son teslim tarihi ve saati gelecekte olmalı.'), { status: 409 });
  if (monad.enabled) {
    const chainBatch = await monad.createBatch(batch);
    batch.chainBatchId = chainBatch.batchId;
    batch.chainCreateTxHash = chainBatch.txHash;
  }
  state.batches.unshift(batch);
  event('published', `${provider.name} ${quantity} porsiyon yayınladı`, batch.chainCreateTxHash ? `MONAD / ${batch.chainCreateTxHash.slice(2, 10).toUpperCase()}` : `PARTİ / ${batch.id.slice(-6).toUpperCase()}`);
}

function updateBatch(body, provider) {
  const batch = findBatch(body.batchId);
  if (!batch || batch.providerId !== provider.id) throw Object.assign(new Error('Bu yayın işletme hesabına ait değil.'), { status: 404 });
  if (batch.status === 'cancelled') throw Object.assign(new Error('Kapatılmış yayın düzenlenemez.'), { status: 409 });
  const quantity = Number(body.quantity);
  const title = String(body.title || '').trim().slice(0, 50);
  const contents = String(body.contents || '').trim().slice(0, 140);
  const allergens = String(body.allergens || '').trim().slice(0, 90);
  const claimTtlSeconds = claimTtlSecondsFor(body);
  const deadlineAt = istanbulTimestamp(body.pickupDate, body.deadline);
  if (title.length < 3 || contents.length < 3 || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) throw Object.assign(new Error('Paket adı, içerik ve 1–30 arası adet gerekli.'), { status: 400 });
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw Object.assign(new Error('Teslim tarihi ve saati gelecekte olmalı.'), { status: 409 });
  const locked = batch.slots.filter(portion => portion.state !== 'available').length;
  if (quantity < locked) throw Object.assign(new Error(`Adet ${locked} değerinin altına inemez; ayrılmış veya teslim edilmiş porsiyon var.`), { status: 409 });
  while (batch.slots.length < quantity) batch.slots.push(slot());
  while (batch.slots.length > quantity) {
    const index = batch.slots.map(portion => portion.state).lastIndexOf('available');
    if (index < 0) break;
    batch.slots.splice(index, 1);
  }
  batch.title = title; batch.contents = contents; batch.allergens = allergens || 'Belirtilmedi';
  batch.deadline = body.deadline; batch.deadlineAt = deadlineAt; batch.claimTtlSeconds = claimTtlSeconds;
  event('updated', `${batch.provider} yayınını güncelledi`, `PARTİ / ${batch.id.slice(-6).toUpperCase()}`);
}

function cancelBatch(body, provider) {
  const batch = findBatch(body.batchId);
  if (!batch || batch.providerId !== provider.id) throw Object.assign(new Error('Bu yayın işletme hesabına ait değil.'), { status: 404 });
  if (batch.status === 'cancelled') throw Object.assign(new Error('Yayın zaten kapalı.'), { status: 409 });
  const reasons = new Set(['Erken tükendi', 'İmha edildi', 'Yayın hatası']);
  const reason = reasons.has(body.reason) ? body.reason : 'İşletme tarafından kapatıldı';
  const note = String(body.note || '').trim().replace(/[.!?]+$/, '').slice(0, 140);
  const explanation = note ? `${reason} — ${note}` : reason;
  for (const portion of batch.slots) {
    if (portion.state !== 'claimed' || !portion.ownerId) continue;
    const notices = deviceNotices.get(portion.ownerId) || [];
    notices.push({ id: randomBytes(8).toString('hex'), type: 'batch_cancelled', title: 'Ayırdığın paket kaldırıldı', message: `${batch.provider}, “${batch.title}” yayınını kapattı: ${explanation}. Teslim kodun artık geçerli değil.`, at: new Date().toISOString() });
    deviceNotices.set(portion.ownerId, notices.slice(-3));
  }
  batch.status = 'cancelled'; batch.cancelReason = explanation;
  batch.slots = batch.slots.map(portion => portion.state === 'redeemed' ? portion : { ...portion, state: 'cancelled', code: null, ownerId: null, claimExpiresAt: null });
  event('cancelled', `${batch.provider} · ${batch.title} yayınını kapattı: ${explanation}`, `PARTİ / ${batch.id.slice(-6).toUpperCase()}`);
}

function json(res, status, data, extraHeaders = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders }); res.end(JSON.stringify(data)); }
async function readJson(req) { let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 12_000) throw Object.assign(new Error('İstek çok büyük.'), { status: 413 }); } try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Geçersiz JSON.'), { status: 400 }); } }
function validDevice(value) { return /^[a-f0-9-]{20,50}$/i.test(String(value || '')); }
function requireProvider(req) { const provider = providerSession(req); if (!provider) throw Object.assign(new Error('İşletme cüzdan oturumu gerekli.'), { status: 403 }); return provider; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/provider/status') {
      const provider = providerSession(req);
      return json(res, 200, { authenticated: Boolean(provider), provider });
    }
    if (url.pathname === '/api/provider/challenge' && req.method === 'GET') {
      const address = url.searchParams.get('address');
      if (!isAddress(address || '')) throw Object.assign(new Error('Geçerli bir cüzdan adresi gerekli.'), { status: 400 });
      return json(res, 200, providerChallenge(address, url.searchParams.get('purpose') || 'login'));
    }
    if (url.pathname === '/api/provider/apply' && req.method === 'POST') {
      const body = await readJson(req);
      if (!isAddress(body.address || '') || typeof body.signature !== 'string') throw Object.assign(new Error('Cüzdan imzası eksik.'), { status: 400 });
      const address = getAddress(body.address);
      const key = challengeKey('application', address);
      const challenge = authChallenges.get(key);
      authChallenges.delete(key);
      if (!challenge || challenge.expiresAt <= Date.now()) throw Object.assign(new Error('Başvuru imzasının süresi doldu; yeniden dene.'), { status: 403 });
      let recovered;
      try { recovered = getAddress(verifyMessage(challenge.message, body.signature)); } catch { throw Object.assign(new Error('Cüzdan imzası doğrulanamadı.'), { status: 403 }); }
      if (recovered !== address) throw Object.assign(new Error('İmza bağlı cüzdanla eşleşmiyor.'), { status: 403 });
      const businessName = String(body.businessName || '').trim().slice(0, 90);
      const businessAddress = String(body.businessAddress || '').trim().slice(0, 180);
      if (businessName.length < 3 || businessAddress.length < 10) throw Object.assign(new Error('İşletme adı ve açık teslim adresi gerekli.'), { status: 400 });
      const application = {
        wallet: address,
        businessName,
        businessAddress,
        status: hackathonMode ? 'hackathon_access' : 'pending',
        submittedAt: new Date().toISOString(),
      };
      providerApplications.set(address.toLowerCase(), application);
      if (!hackathonMode) return json(res, 202, { application, message: 'Başvurun alındı. Platform incelemesi tamamlanmadan ilan yayınlanamaz.' });
      providerProfiles.set(address.toLowerCase(), { id: `wallet:${address.toLowerCase()}`, name: businessName, location: businessAddress, hackathon: true, status: 'active' });
      const provider = providerForAddress(address);
      const token = randomBytes(32).toString('hex');
      providerSessions.set(token, { provider, expiresAt: Date.now() + 4 * 60 * 60_000 });
      return json(res, 200, { authenticated: true, provider, application, message: 'İşletme bilgilerin kaydedildi; panelin açıldı.' }, { 'set-cookie': `sp_provider=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400` });
    }
    if (url.pathname === '/api/provider/login' && req.method === 'POST') {
      const body = await readJson(req);
      if (!isAddress(body.address || '') || typeof body.signature !== 'string') throw Object.assign(new Error('Cüzdan imzası eksik.'), { status: 400 });
      const address = getAddress(body.address);
      const key = challengeKey('login', address);
      const challenge = authChallenges.get(key);
      authChallenges.delete(key);
      if (!challenge || challenge.expiresAt <= Date.now()) throw Object.assign(new Error('Giriş isteğinin süresi doldu; yeniden bağlan.'), { status: 403 });
      let recovered;
      try { recovered = getAddress(verifyMessage(challenge.message, body.signature)); } catch { throw Object.assign(new Error('Cüzdan imzası doğrulanamadı.'), { status: 403 }); }
      if (recovered !== address) throw Object.assign(new Error('İmza bağlı cüzdanla eşleşmiyor.'), { status: 403 });
      const provider = providerForAddress(address);
      if (!provider.approved) {
        const application = providerApplications.get(address.toLowerCase());
        const message = application?.status === 'pending' ? 'Başvurun incelemede. Kamuya açık işletme bilgileri eşleşmeden yayın yetkisi açılmaz.' : 'Bu cüzdan yayın yetkisi olan bir işletmeyle eşleşmiyor. Önce aşağıdaki işletme başvurusunu tamamla.';
        throw Object.assign(new Error(message), { status: 403 });
      }
      const token = randomBytes(32).toString('hex');
      providerSessions.set(token, { provider, expiresAt: Date.now() + 4 * 60 * 60_000 });
      return json(res, 200, { authenticated: true, provider }, { 'set-cookie': `sp_provider=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400` });
    }
    if (url.pathname === '/api/provider/logout' && req.method === 'POST') {
      providerSessions.delete(cookieValue(req, 'sp_provider'));
      return json(res, 200, { authenticated: false }, { 'set-cookie': 'sp_provider=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/api/state') return json(res, 200, publicState(url.searchParams.get('deviceId') || ''));
    if (url.pathname === '/api/claim/prepare' && req.method === 'POST') { const body = await readJson(req); if (!validDevice(body.deviceId)) throw Object.assign(new Error('Geçersiz cihaz anahtarı.'), { status: 400 }); return json(res, 200, await prepareChainClaim(body)); }
    if (url.pathname === '/api/claim' && req.method === 'POST') {
      const body = await readJson(req); if (!validDevice(body.deviceId)) throw Object.assign(new Error('Geçersiz cihaz anahtarı.'), { status: 400 });
      const batch = findBatch(body.batchId); let chainClaim = null;
      if (batch?.chainBatchId) {
        const pending = pendingChainClaims.get(body.chainProof?.token); pendingChainClaims.delete(body.chainProof?.token);
        if (!pending || pending.expiresAt <= Date.now() || pending.deviceId !== body.deviceId || pending.batchId !== body.batchId) throw Object.assign(new Error('Monad ayırma imzasının süresi doldu; yeniden dene.'), { status: 409 });
        const result = await monad.claim(pending, body.chainProof || {});
        chainClaim = { slotIndex: pending.slotIndex, secret: pending.secret, txHash: result.txHash };
      }
      claim(body.deviceId, body.batchId, chainClaim); return json(res, 200, publicState(body.deviceId));
    }
    if (url.pathname === '/api/release/prepare' && req.method === 'POST') { const body = await readJson(req); if (!validDevice(body.deviceId)) throw Object.assign(new Error('Geçersiz cihaz anahtarı.'), { status: 400 }); return json(res, 200, await prepareChainRelease(body)); }
    if (url.pathname === '/api/release' && req.method === 'POST') {
      const body = await readJson(req); let chainRelease = null; const batch = findBatch(body.batchId); const portion = batch?.slots[Number(body.slotIndex)];
      if (portion?.claimTxHash) {
        const pending = pendingChainReleases.get(body.chainProof?.token); pendingChainReleases.delete(body.chainProof?.token);
        if (!pending || pending.expiresAt <= Date.now() || pending.deviceId !== body.deviceId || pending.batchId !== body.batchId || pending.slotIndex !== Number(body.slotIndex)) throw Object.assign(new Error('Monad bırakma imzasının süresi doldu; yeniden dene.'), { status: 409 });
        chainRelease = await monad.release(pending.release, body.chainProof || {});
      }
      release(body.deviceId, body.batchId, Number(body.slotIndex), chainRelease); return json(res, 200, publicState(body.deviceId));
    }
    if (url.pathname === '/api/redeem' && req.method === 'POST') { const provider = requireProvider(req); const body = await readJson(req); const result = await redeem(body.code, provider.id); return json(res, 200, { state: publicState(body.deviceId || ''), redeemed: { batch: result.batch.title, slot: result.index, txHash: result.chainResult?.txHash || null } }); }
    if (url.pathname === '/api/publish' && req.method === 'POST') { const provider = requireProvider(req); const body = await readJson(req); await publish(body, provider); return json(res, 200, publicState(body.deviceId || '')); }
    if (url.pathname === '/api/batch/update' && req.method === 'POST') { const provider = requireProvider(req); const body = await readJson(req); updateBatch(body, provider); return json(res, 200, publicState(body.deviceId || '')); }
    if (url.pathname === '/api/batch/cancel' && req.method === 'POST') { const provider = requireProvider(req); const body = await readJson(req); cancelBatch(body, provider); return json(res, 200, publicState()); }
    if (url.pathname === '/api/reset' && req.method === 'POST') { requireProvider(req); state = url.searchParams.get('empty') === '1' ? { batches: [], events: [] } : seededState(); deviceNotices.clear(); return json(res, 200, publicState()); }
    if (url.pathname === '/api/network') {
      const response = await fetch(process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(5500) });
      const data = await response.json(); if (!data.result) throw new Error('Monad RPC');
      return json(res, 200, { chainId: Number(process.env.MONAD_CHAIN_ID || 10143), latestBlock: Number.parseInt(data.result, 16), contractAddress: process.env.MONAD_CONTRACT_ADDRESS || null });
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, shared: true, hackathonMode, claimTtlSeconds: defaultClaimTtlSeconds });
    const file = url.pathname === '/' || url.pathname === '/isletme' || url.pathname === '/isletme/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!allowed.has(file)) { res.writeHead(404); return res.end('Not found'); }
    const data = await readFile(path.join(root, file));
    res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://testnet-rpc.monad.xyz; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    res.end(data);
  } catch (error) { json(res, error.status || 502, { error: error.message || 'İşlem tamamlanamadı.' }); }
});

server.listen(port, '127.0.0.1', () => console.log(`SonPorsiyon: http://127.0.0.1:${port}`));
