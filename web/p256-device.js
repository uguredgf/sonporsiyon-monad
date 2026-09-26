const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const utf8 = value => new TextEncoder().encode(value);
const hex = value => bytes(value).reduce((result, item) => result + item.toString(16).padStart(2, '0'), '0x');
const fromHex = value => {
  const normalized = String(value).replace(/^0x/, '');
  if (normalized.length % 2) throw new Error('Geçersiz hex uzunluğu.');
  return Uint8Array.from(normalized.match(/.{2}/g) || [], pair => Number.parseInt(pair, 16));
};
const uint = (value, length) => {
  let current = BigInt(value);
  const out = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) { out[index] = Number(current & 255n); current >>= 8n; }
  if (current) throw new Error(`${length} bayta sığmayan sayı.`);
  return out;
};
const fixedHex = (value, length) => {
  const out = fromHex(value);
  if (out.length !== length) throw new Error(`${length} bayt bekleniyordu.`);
  return out;
};

function normalizeSignature(signature) {
  const raw = bytes(signature);
  if (raw.length !== 64) throw new Error('WebCrypto P-256 imzası 64 bayt olmalı.');
  const r = raw.slice(0, 32);
  let sValue = BigInt(hex(raw.slice(32)));
  if (sValue > P256_N / 2n) sValue = P256_N - sValue;
  return { r: hex(r), s: hex(uint(sValue, 32)) };
}

export async function createDeviceKey() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}

export function getOrCreateDeviceKey() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('sonporsiyon-device-keys', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const read = database.transaction('keys', 'readonly').objectStore('keys').get('claim-key');
      read.onerror = () => reject(read.error);
      read.onsuccess = async () => {
        if (read.result) { resolve(read.result); return; }
        try {
          const keyPair = await createDeviceKey();
          const write = database.transaction('keys', 'readwrite').objectStore('keys').put(keyPair, 'claim-key');
          write.onerror = () => reject(write.error);
          write.onsuccess = () => resolve(keyPair);
        } catch (error) { reject(error); }
      };
    };
  });
}

export async function exportDevicePublicKey(keyPair) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Beklenmeyen P-256 açık anahtarı.');
  return { qx: hex(raw.slice(1, 33)), qy: hex(raw.slice(33, 65)) };
}

// Solidity claimP256Digest ile aynı abi.encodePacked mesajı. WebCrypto bu mesajı
// SHA-256 ile özetleyip imzalar; kontrat aynı özeti EIP-7951 precompile'a verir.
export function claimMessage({ chainId, contract, batchId, slotId, nullifier, pickupCommitment, nonce, signatureDeadline }) {
  return concat(
    utf8('SONPORSIYON_CLAIM_P256_V1'), uint(chainId, 32), fixedHex(contract, 20),
    fixedHex(batchId, 32), uint(slotId, 4), fixedHex(nullifier, 32),
    fixedHex(pickupCommitment, 32), uint(nonce, 32), uint(signatureDeadline, 6),
  );
}

export async function signClaim(keyPair, claim) {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, claimMessage(claim));
  return { ...normalizeSignature(signature), ...(await exportDevicePublicKey(keyPair)) };
}

export function releaseMessage({ chainId, contract, batchId, slotId, nonce, signatureDeadline }) {
  return concat(
    utf8('SONPORSIYON_RELEASE_P256_V1'), uint(chainId, 32), fixedHex(contract, 20),
    fixedHex(batchId, 32), uint(slotId, 4), uint(nonce, 32), uint(signatureDeadline, 6),
  );
}

export async function signRelease(keyPair, release) {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, releaseMessage(release));
  return { ...normalizeSignature(signature), ...(await exportDevicePublicKey(keyPair)) };
}
