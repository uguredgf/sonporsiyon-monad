import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch {
  console.log('SKIP: production Worker D1 test requires Node.js 22+; static parity test still passed.');
  process.exit(0);
}

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
for (const name of ['0000_rapid_princess_powerful.sql', '0001_harsh_turbo.sql', '0002_windy_doctor_octopus.sql', '0003_rapid_blink.sql', '0004_dashing_anita_blake.sql']) {
  const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');
  sqlite.exec(migration.replaceAll('--> statement-breakpoint', '\n'));
}

const { default: worker } = await import('../dist/server/index.js');
const env = {
  DB: new D1Database(sqlite),
  PROVIDER_USER_ID: 'owner-1',
  PROVIDER_VERIFIED: '1',
  PROVIDER_ID: 'test-provider',
  PROVIDER_NAME: 'Test Fırını',
  PROVIDER_WALLET: '0x1111111111111111111111111111111111111111',
};
const ownerHeaders = { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner-1' };
const call = (path, { method = 'GET', body, owner = false } = {}) => worker.fetch(new Request(`https://sonporsiyon.test${path}`, {
  method,
  headers: owner ? ownerHeaders : { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}), env);

const status = await call('/api/provider/status', { owner: true });
assert.equal(status.status, 200);
assert.equal((await status.json()).provider.name, 'Test Fırını');

const unauthorized = await call('/api/publish', { method: 'POST', body: { title: 'Yetkisiz' } });
assert.equal(unauthorized.status, 403, 'Production publishing must require the site owner');

const deadline = new Date(Date.now() + 2 * 60 * 60_000);
const pickupDate = `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}`;
const pickupTime = `${String(deadline.getHours()).padStart(2, '0')}:${String(deadline.getMinutes()).padStart(2, '0')}`;
const prepared = new Date();
const preparedTime = `${String(prepared.getHours()).padStart(2, '0')}:${String(prepared.getMinutes()).padStart(2, '0')}`;
const publish = await call('/api/publish', { method: 'POST', owner: true, body: {
  title: 'Akşam paketi', contents: 'Sandviç ve ekmek', quantity: 2,
  pickupDate, deadline: pickupTime, allergens: 'Gluten', address: 'Beyoğlu, İstanbul',
  latitude: 41.0327, longitude: 28.9832, claimTtlMinutes: 45, preparedAt: preparedTime,
} });
assert.equal(publish.status, 200);
const publishedState = await publish.json();
const batch = publishedState.batches.find(item => item.title === 'Akşam paketi');
assert.ok(batch);
assert.equal(batch.provider, 'Test Fırını');
assert.equal(batch.claimTtlSeconds, 45 * 60);
assert.equal(batch.deadlineAt, new Date(`${pickupDate}T${pickupTime}:00+03:00`).getTime(), 'Food deadline is parsed in the Istanbul time zone');

const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
const tomorrowDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
const invalidPreparation = await call('/api/publish', { method: 'POST', owner: true, body: {
  title: 'Geç hazırlanmış paket', contents: 'Test içeriği', quantity: 1,
  pickupDate: tomorrowDate, deadline: '12:00', preparedAt: '13:00', allergens: 'Yok', address: 'Beyoğlu, İstanbul',
  latitude: 41.0327, longitude: 28.9832, claimTtlMinutes: 30,
} });
assert.equal(invalidPreparation.status, 400, 'Preparation time cannot be later than the food deadline');

const secondPublish = await call('/api/publish', { method: 'POST', owner: true, body: {
  title: 'İkinci akşam paketi', contents: 'Çorba', quantity: 1,
  pickupDate, deadline: pickupTime, allergens: 'Yok', address: 'Kadıköy, İstanbul',
  latitude: 40.9819, longitude: 29.0267, claimTtlMinutes: 30, preparedAt: preparedTime,
} });
assert.equal(secondPublish.status, 200);
const secondBatch = (await secondPublish.json()).batches.find(item => item.title === 'İkinci akşam paketi');

const deviceId = '00000000-0000-4000-8000-000000000777';
assert.equal((await call('/api/claim', { method: 'POST', body: { deviceId, batchId: batch.id } })).status, 200);
assert.equal((await call('/api/claim', { method: 'POST', body: { deviceId, batchId: secondBatch.id } })).status, 409, 'A device can hold only one active claim across the network');
const update = await call('/api/batch/update', { method: 'POST', owner: true, body: {
  batchId: batch.id, title: 'Güncellenmiş akşam paketi', contents: 'Sandviç, ekmek ve meyve',
  quantity: 3, pickupDate, deadline: pickupTime, allergens: 'Gluten ve süt', claimTtlMinutes: 60,
} });
assert.equal(update.status, 200);
const updatedBatch = (await update.json()).batches.find(item => item.id === batch.id);
assert.equal(updatedBatch.slots.length, 3);
assert.equal(updatedBatch.claimTtlSeconds, 60 * 60);

const cancel = await call('/api/batch/cancel', { method: 'POST', owner: true, body: {
  batchId: batch.id, reason: 'İmha edildi', note: 'Soğuk zincir kesintisi fark edildi.',
} });
assert.equal(cancel.status, 200);
const cancelled = (await cancel.json()).batches.find(item => item.id === batch.id);
assert.equal(cancelled.status, 'cancelled');
assert.ok(cancelled.slots.every(slot => slot.state !== 'claimed'));

const notified = await call(`/api/state?deviceId=${deviceId}`);
const notifiedState = await notified.json();
assert.match(notifiedState.notices[0].message, /İmha edildi.*Soğuk zincir/i);
assert.equal((await (await call(`/api/state?deviceId=${deviceId}`)).json()).notices.length, 0, 'Notices are delivered once');
assert.equal((await call('/api/claim', { method: 'POST', body: { deviceId, batchId: batch.id } })).status, 409, 'Cancelled batches cannot be claimed');

const redeemDeviceId = '00000000-0000-4000-8000-000000000778';
const claimedForRedeem = await call('/api/claim', { method: 'POST', body: { deviceId: redeemDeviceId, batchId: secondBatch.id } });
assert.equal(claimedForRedeem.status, 200);
const claimedState = await claimedForRedeem.json();
const pickupCode = claimedState.batches.find(item => item.id === secondBatch.id).slots.find(slot => slot.ownerId === redeemDeviceId).code;
const redeemed = await call('/api/redeem', { method: 'POST', owner: true, body: { code: pickupCode, deviceId: redeemDeviceId } });
assert.equal(redeemed.status, 200);
assert.equal((await redeemed.json()).state.metrics.redeemedToday, 1, 'Redeeming a portion updates the Istanbul-day metric');
assert.equal((await call('/health')).status, 200);

sqlite.close();
console.log('PASS: production Worker publish, claim, update, cancel and notification flow.');
