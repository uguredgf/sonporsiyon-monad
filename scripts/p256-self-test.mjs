import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto;
const { createDeviceKey, exportDevicePublicKey, claimMessage, releaseMessage, signClaim, signRelease } = await import('../web/p256-device.js');

const claim = {
  chainId: 143n,
  contract: '0x1111111111111111111111111111111111111111',
  batchId: `0x${'22'.repeat(32)}`,
  slotId: 7,
  nullifier: `0x${'33'.repeat(32)}`,
  pickupCommitment: `0x${'44'.repeat(32)}`,
  nonce: 0,
  signatureDeadline: 2_000_000_000,
};

const keys = await createDeviceKey();
const message = claimMessage(claim);
const signature = await signClaim(keys, claim);
const rawSignature = new Uint8Array([...Buffer.from(signature.r.slice(2), 'hex'), ...Buffer.from(signature.s.slice(2), 'hex')]);
const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, rawSignature, message);
if (!valid) throw new Error('P-256 imza öz sınaması başarısız.');
const publicKey = await exportDevicePublicKey(keys);
if (publicKey.qx !== signature.qx || publicKey.qy !== signature.qy) throw new Error('Açık anahtar eşleşmedi.');
const release = { chainId: claim.chainId, contract: claim.contract, batchId: claim.batchId, slotId: claim.slotId, nonce: 1, signatureDeadline: claim.signatureDeadline };
const releaseSignature = await signRelease(keys, release);
const rawReleaseSignature = new Uint8Array([...Buffer.from(releaseSignature.r.slice(2), 'hex'), ...Buffer.from(releaseSignature.s.slice(2), 'hex')]);
assertRelease(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, rawReleaseSignature, releaseMessage(release)));
console.log('P-256 device-key claim/release messages, low-s signatures and verification: PASS');

function assertRelease(validRelease) {
  if (!validRelease) throw new Error('P-256 bırakma imzası öz sınaması başarısız.');
}
