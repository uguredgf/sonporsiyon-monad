import { randomBytes, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import {
  Contract, JsonRpcProvider, Wallet, concat, keccak256, sha256, solidityPacked,
  toUtf8Bytes, zeroPadValue,
} from 'ethers';

globalThis.crypto ??= webcrypto;
const { createDeviceKey, exportDevicePublicKey, signClaim, signRelease } = await import('../web/p256-device.js');

const contractAddress = process.env.MONAD_CONTRACT_ADDRESS;
const providerKey = process.env.DEPLOYER_PRIVATE_KEY;
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
if (!contractAddress || !providerKey || !relayerKey) {
  console.error('MONAD_CONTRACT_ADDRESS, DEPLOYER_PRIVATE_KEY ve RELAYER_PRIVATE_KEY ortam değişkenleri gerekli.');
  process.exit(1);
}

const source = await readFile(new URL('../contracts/SurplusPortions.sol', import.meta.url), 'utf8');
const input = { language: 'Solidity', sources: { 'SurplusPortions.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi'] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const abi = output.contracts['SurplusPortions.sol'].SurplusPortions.abi;
const expectedChainId = BigInt(process.env.MONAD_CHAIN_ID || '10143');
const rpc = new JsonRpcProvider(process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz');
const network = await rpc.getNetwork();
if (network.chainId !== expectedChainId) throw new Error(`Monad ${expectedChainId} yerine ${network.chainId} bulundu.`);

const provider = new Wallet(providerKey, rpc);
const relayer = new Wallet(relayerKey, rpc);
const writable = new Contract(contractAddress, abi, provider);
const now = Math.floor(Date.now() / 1000);
const metadataHash = keccak256(toUtf8Bytes(`sonporsiyon-e2e-${now}`));
const createReceipt = await (await writable.createBatch(metadataHash, 'ipfs://sonporsiyon-e2e', now + 900, 120, 2)).wait();
const batchLog = createReceipt.logs.map(log => { try { return writable.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'BatchCreated');
if (!batchLog) throw new Error('BatchCreated olayı bulunamadı.');
const batchId = batchLog.args.batchId;

const relayed = writable.connect(relayer);

async function claimSlot(slotId, deviceKey) {
  const secret = `0x${randomBytes(32).toString('hex')}`;
  const nullifier = `0x${randomBytes(32).toString('hex')}`;
  const pickupCommitment = sha256(solidityPacked(['string', 'uint256', 'bytes32', 'uint32', 'bytes32'], ['SONPORSIYON_PICKUP_V1', network.chainId, batchId, slotId, secret]));
  const { qx, qy } = await exportDevicePublicKey(deviceKey);
  const identity = keccak256(concat([qx, qy]));
  const nonce = await writable.p256Nonces(identity);
  const signatureDeadline = Math.floor(Date.now() / 1000) + 600;
  const signature = await signClaim(deviceKey, { chainId: network.chainId, contract: contractAddress, batchId, slotId, nullifier, pickupCommitment, nonce, signatureDeadline });
  const receipt = await (await relayed.claimWithP256(batchId, slotId, nullifier, pickupCommitment, signatureDeadline, signature.r, signature.s, signature.qx, signature.qy)).wait();
  return { receipt, secret, identity };
}

const firstDeviceKey = await createDeviceKey();
const firstClaim = await claimSlot(0, firstDeviceKey);
const releaseNonce = await writable.p256Nonces(firstClaim.identity);
const releaseDeadline = Math.floor(Date.now() / 1000) + 600;
const releaseSignature = await signRelease(firstDeviceKey, { chainId: network.chainId, contract: contractAddress, batchId, slotId: 0, nonce: releaseNonce, signatureDeadline: releaseDeadline });
const releaseReceipt = await (await relayed.releaseWithP256(batchId, 0, releaseDeadline, releaseSignature.r, releaseSignature.s, releaseSignature.qx, releaseSignature.qy)).wait();

const secondDeviceKey = await createDeviceKey();
const secondClaim = await claimSlot(1, secondDeviceKey);
const redeemReceipt = await (await writable.redeem(batchId, 1, zeroPadValue(secondClaim.secret, 32))).wait();

console.log(JSON.stringify({
  contractAddress,
  batchId,
  createTx: createReceipt.hash,
  firstClaimTx: firstClaim.receipt.hash,
  releaseTx: releaseReceipt.hash,
  secondClaimTx: secondClaim.receipt.hash,
  redeemTx: redeemReceipt.hash,
}, null, 2));
