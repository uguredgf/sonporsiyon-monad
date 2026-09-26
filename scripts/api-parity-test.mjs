import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, worker, schema] = await Promise.all([
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../worker/runtime.js', import.meta.url), 'utf8'),
  readFile(new URL('../db/schema.ts', import.meta.url), 'utf8'),
]);
const [app, contract, bridge] = await Promise.all([
  readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../contracts/SurplusPortions.sol', import.meta.url), 'utf8'),
  readFile(new URL('../lib/monad-bridge.mjs', import.meta.url), 'utf8'),
]);

const endpointPattern = /url\.pathname\s*===\s*["']([^"']+)["']/g;
const endpoints = source => new Set([...source.matchAll(endpointPattern)].map(match => match[1]));
const local = endpoints(server);
const production = endpoints(worker);
const required = [
  '/api/provider/status', '/api/provider/login', '/api/provider/logout',
  '/api/state', '/api/claim', '/api/release', '/api/redeem', '/api/publish',
  '/api/batch/update', '/api/batch/cancel', '/api/reset', '/api/network', '/health',
];

for (const endpoint of required) {
  assert.ok(local.has(endpoint), `Local API is missing ${endpoint}`);
  assert.ok(production.has(endpoint), `Production Worker is missing ${endpoint}`);
}
assert.match(worker, /provider:\s*authenticated\s*\?\s*providerForEnv/, 'Production status must return the active provider profile');
assert.match(worker, /device_notices/, 'Production cancellation must persist device notices');
assert.match(schema, /cancelReason:\s*text\("cancel_reason"\)/, 'Batch cancellation fields must exist in the D1 schema');
assert.match(schema, /claimTtlSeconds:\s*integer\("claim_ttl_seconds"\)/, 'Per-batch claim duration must exist in the D1 schema');
assert.match(schema, /idx_portions_one_active_claim"\)\.on\(table\.ownerId\)/, 'Only one active claim per device is enforced across the network');
assert.match(schema, /deviceNotices\s*=\s*sqliteTable\("device_notices"/, 'Device notices table must exist in the D1 schema');
assert.match(server, /\/api\/claim\/prepare/, 'Local API must expose the P-256 Monad claim preparation route');
assert.match(app, /signClaim\(keyPair, prepared\.claim\)/, 'Consumer claims must sign the Monad P-256 challenge when the bridge is active');
assert.match(bridge, /claimWithP256/, 'Monad bridge must relay the P-256 claim transaction');
assert.match(bridge, /createBatch/, 'Monad bridge must publish batches onchain');
assert.match(bridge, /\.redeem\(/, 'Monad bridge must close pickups onchain');
assert.match(contract, /address private constant P256VERIFY = address\(0x100\)/, 'Contract must use Monad P-256 verification precompile');
assert.match(contract, /P256_N_HALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8/, 'Contract must enforce the exact low-s boundary for the P-256 curve order');

console.log('API parity: local and production critical routes are present.');
