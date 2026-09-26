const PAGE_HTML = __PAGE_HTML__;
const PAGE_CSS = __PAGE_CSS__;
const PAGE_JS = __PAGE_JS__;
const P256_JS = __P256_JS__;
const IMAGES_BASE64 = __IMAGES_BASE64__;
const DEFAULT_CLAIM_TTL_SECONDS = 1800;
const CLAIM_TTL_OPTIONS = new Set([15, 30, 45, 60]);

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra, "content-type": "application/json; charset=utf-8" } });
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validDevice(value) {
  return /^[a-f0-9-]{20,50}$/i.test(String(value || ""));
}

function claimTtlSecondsFor(body) {
  const minutes = Number(body.claimTtlMinutes || 30);
  if (!CLAIM_TTL_OPTIONS.has(minutes)) fail(400, "Ayırma süresi 15, 30, 45 veya 60 dakika olmalı.");
  return minutes * 60;
}
const istanbulTimestamp = (date, time) => new Date(`${date}T${time}:00+03:00`).getTime();
const istanbulDayBounds = () => {
  const day = new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 10);
  const start = istanbulTimestamp(day, "00:00");
  return [new Date(start).toISOString(), new Date(start + 24 * 60 * 60_000).toISOString()];
};

function isProvider(request, env) {
  const owner = request.headers.get("oai-authenticated-user-id");
  return Boolean(owner && env.PROVIDER_USER_ID && owner === env.PROVIDER_USER_ID && env.PROVIDER_VERIFIED === "1");
}

function providerForEnv(env) {
  return {
    id: env.PROVIDER_ID || "komsu",
    name: env.PROVIDER_NAME || "Komşu Fırın",
    wallet: env.PROVIDER_WALLET || "",
    identityLabel: "Site sahibi",
    verificationLabel: "Kayıt bilgisi eşleştirildi",
    verified: true,
  };
}

function requireProvider(request, env) {
  if (!isProvider(request, env)) fail(403, "Bu işlem yalnız kayıt bilgisi eşleştirilmiş işletmeye açık.");
  return providerForEnv(env);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 12_000) fail(413, "İstek çok büyük.");
  try { return await request.json(); }
  catch { fail(400, "Geçersiz JSON."); }
}

function pickupCode() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return `SP-${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

async function cleanupExpired(db) {
  const now = Date.now();
  const expired = await db.prepare(`
    SELECT p.batch_id AS batchId, p.slot_index AS slotIndex, b.provider AS provider
    FROM portions p JOIN batches b ON b.id = p.batch_id
    WHERE p.state = 'claimed' AND p.claim_expires_at <= ? AND b.deadline_at > ?
  `).bind(now, now).all();
  if (!expired.results.length) return;
  const statements = [];
  for (const row of expired.results) {
    statements.push(db.prepare(`UPDATE portions SET state = 'available', owner_id = NULL, code = NULL, claim_expires_at = NULL WHERE batch_id = ? AND slot_index = ? AND state = 'claimed'`).bind(row.batchId, row.slotIndex));
    statements.push(db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('released', ?, ?, ?)`).bind(`${row.provider} için ayrılan porsiyonun süresi doldu`, `SLOT ${row.slotIndex + 1} / OTOMATİK`, new Date().toISOString()));
  }
  await db.batch(statements);
}

async function publicState(db, deviceId = "") {
  await cleanupExpired(db);
  const [todayStart, tomorrowStart] = istanbulDayBounds();
  const [batchRows, portionRows, eventRows, metricRows] = await Promise.all([
    db.prepare(`SELECT id, provider_id AS providerId, provider, title, contents, deadline, deadline_at AS deadlineAt, prepared_at AS preparedAt, storage, allergens, address, latitude, longitude, claim_ttl_seconds AS claimTtlSeconds, status, cancel_reason AS cancelReason, published_at AS publishedAt FROM batches ORDER BY published_at DESC`).all(),
    db.prepare(`SELECT batch_id AS batchId, slot_index AS slotIndex, state, owner_id AS ownerId, code, claim_expires_at AS claimExpiresAt FROM portions ORDER BY batch_id, slot_index`).all(),
    db.prepare(`SELECT type, text, ref, at FROM events ORDER BY id DESC LIMIT 100`).all(),
    db.prepare(`SELECT SUM(CASE WHEN type = 'redeemed' THEN 1 ELSE 0 END) AS redeemedToday, SUM(CASE WHEN type = 'released' THEN 1 ELSE 0 END) AS releasedToday FROM events WHERE at >= ? AND at < ?`).bind(todayStart, tomorrowStart).first(),
  ]);
  const slotsByBatch = new Map();
  for (const portion of portionRows.results) {
    if (!slotsByBatch.has(portion.batchId)) slotsByBatch.set(portion.batchId, []);
    slotsByBatch.get(portion.batchId).push({
      state: portion.state,
      ownerId: portion.ownerId === deviceId ? deviceId : null,
      code: portion.ownerId === deviceId ? portion.code : null,
      claimExpiresAt: portion.ownerId === deviceId ? portion.claimExpiresAt : null,
    });
  }
  let notices = [];
  if (validDevice(deviceId)) {
    const rows = await db.prepare(`SELECT id, type, title, message, at FROM device_notices WHERE device_id = ? ORDER BY at`).bind(deviceId).all();
    notices = rows.results;
    if (notices.length) await db.prepare(`DELETE FROM device_notices WHERE device_id = ?`).bind(deviceId).run();
  }
  return {
    claimTtlSeconds: DEFAULT_CLAIM_TTL_SECONDS,
    shared: true,
    persistent: true,
    metrics: {
      redeemedToday: Number(metricRows?.redeemedToday || 0),
      releasedToday: Number(metricRows?.releasedToday || 0),
    },
    batches: batchRows.results.map(batch => ({ ...batch, providerVerified: true, slots: slotsByBatch.get(batch.id) || [] })),
    events: [...eventRows.results].reverse(),
    notices,
  };
}

async function claim(db, body) {
  if (!validDevice(body.deviceId)) fail(400, "Geçersiz cihaz anahtarı.");
  await cleanupExpired(db);
  const batch = await db.prepare(`SELECT id, provider, status, cancel_reason AS cancelReason, deadline_at AS deadlineAt, claim_ttl_seconds AS claimTtlSeconds FROM batches WHERE id = ?`).bind(body.batchId).first();
  if (!batch) fail(404, "Parti bulunamadı.");
  if (batch.status === "cancelled") fail(409, `Bu yayın kapatıldı: ${batch.cancelReason || "işletme tarafından kaldırıldı"}`);
  const now = Date.now();
  if (now >= batch.deadlineAt) fail(409, "Bu partinin güvenli teslim süresi kapandı.");
  const existing = await db.prepare(`SELECT 1 FROM portions WHERE owner_id = ? AND state = 'claimed' LIMIT 1`).bind(body.deviceId).first();
  if (existing) fail(409, "Zaten aktif bir paketin var. Önce onu teslim al veya geri bırak.");
  const code = pickupCode();
  const expiry = Math.min(now + batch.claimTtlSeconds * 1000, batch.deadlineAt);
  let result;
  try {
    result = await db.prepare(`
      UPDATE portions SET state = 'claimed', owner_id = ?, code = ?, claim_expires_at = ?
      WHERE batch_id = ? AND slot_index = (
        SELECT slot_index FROM portions WHERE batch_id = ? AND state = 'available' ORDER BY slot_index LIMIT 1
      ) AND state = 'available'
    `).bind(body.deviceId, code, expiry, batch.id, batch.id).run();
  } catch { fail(409, "Aynı anda başka bir kullanıcı bu porsiyonu aldı; tekrar dene."); }
  if (!result.meta.changes) fail(409, "Bu partide alınabilir paket kalmadı.");
  const claimed = await db.prepare(`SELECT slot_index AS slotIndex FROM portions WHERE batch_id = ? AND owner_id = ? AND state = 'claimed'`).bind(batch.id, body.deviceId).first();
  await db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('claimed', ?, ?, ?)`).bind(`${batch.provider} paketinden bir porsiyon ayrıldı`, `SLOT ${claimed.slotIndex + 1}`, new Date().toISOString()).run();
}

async function release(db, body) {
  if (!validDevice(body.deviceId)) fail(400, "Geçersiz cihaz anahtarı.");
  const portion = await db.prepare(`
    SELECT p.slot_index AS slotIndex, b.provider AS provider
    FROM portions p JOIN batches b ON b.id = p.batch_id
    WHERE p.batch_id = ? AND p.slot_index = ? AND p.owner_id = ? AND p.state = 'claimed'
  `).bind(body.batchId, Number(body.slotIndex), body.deviceId).first();
  if (!portion) fail(409, "Aktif ayırma bulunamadı.");
  await db.batch([
    db.prepare(`UPDATE portions SET state = 'available', owner_id = NULL, code = NULL, claim_expires_at = NULL WHERE batch_id = ? AND slot_index = ?`).bind(body.batchId, portion.slotIndex),
    db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('released', ?, ?, ?)`).bind(`${portion.provider} için ayrılan porsiyon geri bırakıldı`, `SLOT ${portion.slotIndex + 1}`, new Date().toISOString()),
  ]);
}

async function redeem(db, code, providerId) {
  await cleanupExpired(db);
  const normalized = String(code || "").trim().toUpperCase();
  const portion = await db.prepare(`
    SELECT p.batch_id AS batchId, p.slot_index AS slotIndex, b.provider, b.title, b.deadline_at AS deadlineAt
    FROM portions p JOIN batches b ON b.id = p.batch_id
    WHERE p.code = ? AND p.state = 'claimed' AND b.provider_id = ?
  `).bind(normalized, providerId).first();
  if (!portion) fail(409, "Kod aktif değil, süresi doldu veya bu sağlayıcıya ait değil.");
  if (Date.now() >= portion.deadlineAt) fail(409, "Güvenli teslim süresi kapandı; kod kullanılamaz.");
  await db.batch([
    db.prepare(`UPDATE portions SET state = 'redeemed', claim_expires_at = NULL WHERE batch_id = ? AND slot_index = ? AND state = 'claimed'`).bind(portion.batchId, portion.slotIndex),
    db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('redeemed', ?, ?, ?)`).bind(`${portion.provider} · ${portion.title} teslim koduyla kapatıldı`, `SLOT ${portion.slotIndex + 1}`, new Date().toISOString()),
  ]);
  return portion;
}

async function publish(db, body, provider) {
  const quantity = Number(body.quantity);
  const claimTtlSeconds = claimTtlSecondsFor(body);
  const latitude = Number(body.latitude); const longitude = Number(body.longitude);
  const preparedAt = String(body.preparedAt || "").trim();
  if (!body.title || !body.contents || !body.address || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) fail(400, "Paket, içerik ve teslim adresi bilgileri gerekli.");
  if (body.latitude === "" || body.longitude === "" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) fail(400, "Teslim noktasının harita konumunu ekle.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preparedAt) || preparedAt > body.deadline) fail(400, "Hazırlanma saati son teslim saatinden sonra olamaz.");
  const deadlineAt = istanbulTimestamp(body.pickupDate, body.deadline);
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) fail(409, "Son teslim tarihi ve saati gelecekte olmalı.");
  const id = `batch-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO batches(id, provider_id, provider, title, contents, deadline, deadline_at, prepared_at, storage, allergens, address, latitude, longitude, claim_ttl_seconds, status, published_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).bind(id, provider.id, provider.name, String(body.title).slice(0, 50), String(body.contents).slice(0, 140), body.deadline, deadlineAt, preparedAt, String(body.storage || "Oda sıcaklığında kapalı paket").slice(0, 80), String(body.allergens || "Belirtilmedi").slice(0, 90), String(body.address).slice(0, 160), latitude, longitude, claimTtlSeconds, now),
  ];
  for (let index = 0; index < quantity; index += 1) statements.push(db.prepare(`INSERT INTO portions(batch_id, slot_index, state) VALUES(?, ?, 'available')`).bind(id, index));
  statements.push(db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('published', ?, ?, ?)`).bind(`${provider.name} ${quantity} porsiyon yayınladı`, `PARTİ / ${id.slice(-6).toUpperCase()}`, now));
  await db.batch(statements);
}

async function updateBatch(db, body, provider) {
  const batch = await db.prepare(`SELECT id, provider_id AS providerId, provider, status FROM batches WHERE id = ?`).bind(body.batchId).first();
  if (!batch || batch.providerId !== provider.id) fail(404, "Bu yayın işletme hesabına ait değil.");
  if (batch.status === "cancelled") fail(409, "Kapatılmış yayın düzenlenemez.");
  const quantity = Number(body.quantity);
  const title = String(body.title || "").trim().slice(0, 50);
  const contents = String(body.contents || "").trim().slice(0, 140);
  const allergens = String(body.allergens || "").trim().slice(0, 90) || "Belirtilmedi";
  const claimTtlSeconds = claimTtlSecondsFor(body);
  const deadlineAt = istanbulTimestamp(body.pickupDate, body.deadline);
  if (title.length < 3 || contents.length < 3 || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) fail(400, "Paket adı, içerik ve 1–30 arası adet gerekli.");
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) fail(409, "Teslim tarihi ve saati gelecekte olmalı.");

  const portionRows = await db.prepare(`SELECT slot_index AS slotIndex, state FROM portions WHERE batch_id = ? ORDER BY slot_index`).bind(batch.id).all();
  const currentCount = portionRows.results.length;
  const locked = portionRows.results.filter(portion => portion.state !== "available");
  if (quantity < locked.length) fail(409, `Adet ${locked.length} değerinin altına inemez; ayrılmış veya teslim edilmiş porsiyon var.`);
  if (quantity < currentCount && portionRows.results.some(portion => portion.slotIndex >= quantity && portion.state !== "available")) {
    fail(409, "Adet, son sıradaki ayrılmış veya teslim edilmiş porsiyonu kaldıramaz.");
  }

  const statements = [
    db.prepare(`UPDATE batches SET title = ?, contents = ?, allergens = ?, deadline = ?, deadline_at = ?, claim_ttl_seconds = ? WHERE id = ?`).bind(title, contents, allergens, body.deadline, deadlineAt, claimTtlSeconds, batch.id),
  ];
  if (quantity < currentCount) statements.push(db.prepare(`DELETE FROM portions WHERE batch_id = ? AND slot_index >= ? AND state = 'available'`).bind(batch.id, quantity));
  for (let slotIndex = currentCount; slotIndex < quantity; slotIndex += 1) statements.push(db.prepare(`INSERT INTO portions(batch_id, slot_index, state) VALUES(?, ?, 'available')`).bind(batch.id, slotIndex));
  statements.push(db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('updated', ?, ?, ?)`).bind(`${batch.provider} yayınını güncelledi`, `PARTİ / ${batch.id.slice(-6).toUpperCase()}`, new Date().toISOString()));
  await db.batch(statements);
}

async function cancelBatch(db, body, provider) {
  const batch = await db.prepare(`SELECT id, provider_id AS providerId, provider, title, status FROM batches WHERE id = ?`).bind(body.batchId).first();
  if (!batch || batch.providerId !== provider.id) fail(404, "Bu yayın işletme hesabına ait değil.");
  if (batch.status === "cancelled") fail(409, "Yayın zaten kapalı.");
  const reasons = new Set(["Erken tükendi", "İmha edildi", "Yayın hatası"]);
  const reason = reasons.has(body.reason) ? body.reason : "İşletme tarafından kapatıldı";
  const note = String(body.note || "").trim().replace(/[.!?]+$/, "").slice(0, 140);
  const explanation = note ? `${reason} — ${note}` : reason;
  const claimed = await db.prepare(`SELECT DISTINCT owner_id AS ownerId FROM portions WHERE batch_id = ? AND state = 'claimed' AND owner_id IS NOT NULL`).bind(batch.id).all();
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`UPDATE batches SET status = 'cancelled', cancel_reason = ? WHERE id = ?`).bind(explanation, batch.id),
    db.prepare(`UPDATE portions SET state = 'cancelled', owner_id = NULL, code = NULL, claim_expires_at = NULL WHERE batch_id = ? AND state != 'redeemed'`).bind(batch.id),
    db.prepare(`INSERT INTO events(type, text, ref, at) VALUES('cancelled', ?, ?, ?)`).bind(`${batch.provider} · ${batch.title} yayınını kapattı: ${explanation}`, `PARTİ / ${batch.id.slice(-6).toUpperCase()}`, now),
  ];
  for (const row of claimed.results) {
    statements.push(db.prepare(`INSERT INTO device_notices(id, device_id, type, title, message, at) VALUES(?, ?, 'batch_cancelled', ?, ?, ?)`).bind(crypto.randomUUID(), row.ownerId, "Ayırdığın paket kaldırıldı", `${batch.provider}, “${batch.title}” yayınını kapattı: ${explanation}. Teslim kodun artık geçerli değil.`, now));
  }
  await db.batch(statements);
}

function imageResponse(name) {
  const binary = atob(IMAGES_BASE64[name]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Response(bytes, { headers: { "content-type": name.endsWith(".jpg") ? "image/jpeg" : "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

function assetResponse(pathname) {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/isletme" || pathname === "/isletme/") return new Response(PAGE_HTML, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
  if (pathname === "/styles.css") return new Response(PAGE_CSS, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
  if (pathname === "/app.js") return new Response(PAGE_JS, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
  if (pathname === "/p256-device.js") return new Response(P256_JS, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
  const imageName = pathname.startsWith("/assets/") ? pathname.slice("/assets/".length) : "";
  if (IMAGES_BASE64[imageName]) return imageResponse(imageName);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!env.DB) fail(503, "Kalıcı veritabanı bağlantısı yok.");
      if (url.pathname === "/api/provider/status") {
        const authenticated = isProvider(request, env);
        return json(200, { authenticated, mode: "site-owner", provider: authenticated ? providerForEnv(env) : null });
      }
      if (url.pathname === "/api/provider/login" && request.method === "POST") {
        if (!isProvider(request, env)) fail(403, "Yayındaki sağlayıcı alanı yalnız site sahibine açık.");
        return json(200, { authenticated: true });
      }
      if (url.pathname === "/api/provider/logout" && request.method === "POST") return json(200, { authenticated: false });
      if (url.pathname === "/api/state") return json(200, await publicState(env.DB, url.searchParams.get("deviceId") || ""));
      if (url.pathname === "/api/claim" && request.method === "POST") { const body = await readJson(request); await claim(env.DB, body); return json(200, await publicState(env.DB, body.deviceId)); }
      if (url.pathname === "/api/release" && request.method === "POST") { const body = await readJson(request); await release(env.DB, body); return json(200, await publicState(env.DB, body.deviceId)); }
      if (url.pathname === "/api/redeem" && request.method === "POST") { const provider = requireProvider(request, env); const body = await readJson(request); const closed = await redeem(env.DB, body.code, provider.id); return json(200, { state: await publicState(env.DB, body.deviceId || ""), redeemed: { batch: closed.title, slot: closed.slotIndex } }); }
      if (url.pathname === "/api/publish" && request.method === "POST") { const provider = requireProvider(request, env); const body = await readJson(request); await publish(env.DB, body, provider); return json(200, await publicState(env.DB, body.deviceId || "")); }
      if (url.pathname === "/api/batch/update" && request.method === "POST") { const provider = requireProvider(request, env); const body = await readJson(request); await updateBatch(env.DB, body, provider); return json(200, await publicState(env.DB, body.deviceId || "")); }
      if (url.pathname === "/api/batch/cancel" && request.method === "POST") { const provider = requireProvider(request, env); const body = await readJson(request); await cancelBatch(env.DB, body, provider); return json(200, await publicState(env.DB, body.deviceId || "")); }
      if (url.pathname === "/api/reset" && request.method === "POST") { requireProvider(request, env); await env.DB.batch([env.DB.prepare("DELETE FROM device_notices"), env.DB.prepare("DELETE FROM portions"), env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM batches")]); return json(200, await publicState(env.DB)); }
      if (url.pathname === "/api/network") {
        const response = await fetch(env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
        const data = await response.json();
        if (!data.result) fail(502, "Monad RPC yanıt vermedi.");
        return json(200, { chainId: Number(env.MONAD_CHAIN_ID || 10143), latestBlock: Number.parseInt(data.result, 16), contractAddress: env.MONAD_CONTRACT_ADDRESS || null });
      }
      if (url.pathname === "/health") { await env.DB.prepare("SELECT 1").first(); return json(200, { ok: true, shared: true, persistent: true, claimTtlSeconds: DEFAULT_CLAIM_TTL_SECONDS }); }
      return assetResponse(url.pathname) || new Response("Not found", { status: 404, headers });
    } catch (error) {
      if (!error.status || error.status >= 500) console.error("SonPorsiyon Worker error", error);
      return json(error.status || 500, { error: error.message || "İşlem tamamlanamadı." });
    }
  },
};
