import { Contract, JsonRpcProvider, Wallet, concat, keccak256, sha256, solidityPacked, toUtf8Bytes } from 'ethers';
import { randomBytes } from 'node:crypto';

const ABI = [
  'event BatchCreated(bytes32 indexed batchId,address indexed provider,bytes32 metadataHash,string metadataURI,uint48 pickupDeadline,uint32 claimTtl,uint32 slotCount)',
  'function createBatch(bytes32 metadataHash,string metadataURI,uint48 pickupDeadline,uint32 claimTtl,uint32 slotCount) returns (bytes32)',
  'function claimWithP256(bytes32 batchId,uint32 slotId,bytes32 nullifier,bytes32 pickupCommitment,uint48 signatureDeadline,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)',
  'function releaseWithP256(bytes32 batchId,uint32 slotId,uint48 signatureDeadline,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)',
  'function redeem(bytes32 batchId,uint32 slotId,bytes32 pickupSecret)',
  'function p256Nonces(bytes32 identity) view returns (uint256)',
];

const randomHex = size => `0x${randomBytes(size).toString('hex')}`;

export function createMonadBridge(environment = process.env) {
  const chainId = BigInt(environment.MONAD_CHAIN_ID || '10143');
  const rpcUrl = environment.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
  const contractAddress = String(environment.MONAD_CONTRACT_ADDRESS || '');
  const providerKey = String(environment.DEPLOYER_PRIVATE_KEY || '');
  const relayerKey = String(environment.RELAYER_PRIVATE_KEY || '');
  const enabled = Boolean(contractAddress && providerKey && relayerKey);
  const explorerUrl = environment.MONAD_EXPLORER_URL || 'https://testnet.monadvision.com';
  let networkChecked = false;
  let providerContract;
  let relayerContract;

  async function contracts() {
    if (!enabled) throw Object.assign(new Error('Monad testnet köprüsü yapılandırılmadı.'), { status: 503 });
    if (!providerContract) {
      const rpc = new JsonRpcProvider(rpcUrl);
      const network = await rpc.getNetwork();
      if (network.chainId !== chainId) throw new Error(`Monad ${chainId} yerine ${network.chainId} ağına bağlanıldı.`);
      networkChecked = true;
      providerContract = new Contract(contractAddress, ABI, new Wallet(providerKey, rpc));
      relayerContract = providerContract.connect(new Wallet(relayerKey, rpc));
    }
    return { providerContract, relayerContract };
  }

  return {
    enabled,
    status() {
      return { enabled, chainId: Number(chainId), contractAddress: enabled ? contractAddress : null, explorerUrl, networkChecked };
    },
    async createBatch(batch) {
      const { providerContract: contract } = await contracts();
      const metadata = JSON.stringify({ id: batch.id, provider: batch.provider, title: batch.title, contents: batch.contents, address: batch.address });
      const metadataHash = keccak256(toUtf8Bytes(metadata));
      const transaction = await contract.createBatch(metadataHash, `sonporsiyon://batch/${batch.id}`, Math.floor(batch.deadlineAt / 1000), batch.claimTtlSeconds, batch.slots.length);
      const receipt = await transaction.wait();
      const created = receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'BatchCreated');
      if (!created) throw new Error('Monad BatchCreated olayı alınamadı.');
      return { batchId: created.args.batchId, txHash: receipt.hash };
    },
    async prepareClaim({ chainBatchId, slotIndex, qx, qy }) {
      const { providerContract: contract } = await contracts();
      const identity = keccak256(concat([qx, qy]));
      const nonce = await contract.p256Nonces(identity);
      const secret = randomHex(32);
      const nullifier = randomHex(32);
      const pickupCommitment = sha256(solidityPacked(
        ['string', 'uint256', 'bytes32', 'uint32', 'bytes32'],
        ['SONPORSIYON_PICKUP_V1', chainId, chainBatchId, slotIndex, secret],
      ));
      const signatureDeadline = Math.floor(Date.now() / 1000) + 300;
      return {
        secret,
        claim: { chainId: chainId.toString(), contract: contractAddress, batchId: chainBatchId, slotId: slotIndex, nullifier, pickupCommitment, nonce: nonce.toString(), signatureDeadline },
      };
    },
    async claim(prepared, signature) {
      const { relayerContract: contract } = await contracts();
      const claim = prepared.claim;
      const transaction = await contract.claimWithP256(claim.batchId, claim.slotId, claim.nullifier, claim.pickupCommitment, claim.signatureDeadline, signature.r, signature.s, signature.qx, signature.qy);
      const receipt = await transaction.wait();
      return { txHash: receipt.hash };
    },
    async prepareRelease({ chainBatchId, slotIndex, qx, qy }) {
      const { providerContract: contract } = await contracts();
      const identity = keccak256(concat([qx, qy]));
      const nonce = await contract.p256Nonces(identity);
      return { chainId: chainId.toString(), contract: contractAddress, batchId: chainBatchId, slotId: slotIndex, nonce: nonce.toString(), signatureDeadline: Math.floor(Date.now() / 1000) + 300 };
    },
    async release(release, signature) {
      const { relayerContract: contract } = await contracts();
      const transaction = await contract.releaseWithP256(release.batchId, release.slotId, release.signatureDeadline, signature.r, signature.s, signature.qx, signature.qy);
      const receipt = await transaction.wait();
      return { txHash: receipt.hash };
    },
    async redeem({ chainBatchId, slotIndex, secret }) {
      const { providerContract: contract } = await contracts();
      const transaction = await contract.redeem(chainBatchId, slotIndex, secret);
      const receipt = await transaction.wait();
      return { txHash: receipt.hash };
    },
  };
}
