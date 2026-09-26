import { readFile } from 'node:fs/promises';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

const rpcUrl = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
const expectedChainId = BigInt(process.env.MONAD_CHAIN_ID || '10143');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

if (!privateKey) {
  console.error('DEPLOYER_PRIVATE_KEY eksik. Anahtarı dosyaya veya komut satırı argümanına yazmayın; yalnız ortam değişkeni kullanın.');
  process.exit(1);
}

const source = await readFile(new URL('../contracts/SurplusPortions.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'SurplusPortions.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter(item => item.severity === 'error');
if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'));

const artifact = output.contracts['SurplusPortions.sol'].SurplusPortions;
const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
const signer = new Wallet(privateKey, provider);
const network = await provider.getNetwork();
if (network.chainId !== expectedChainId) throw new Error(`Beklenmeyen chainId: ${network.chainId}. ${expectedChainId} bekleniyor.`);

console.log(`Deploy hesabı: ${signer.address}`);
console.log(`Ağ: Monad ${network.chainId === 10143n ? 'Testnet' : 'Mainnet'} (${network.chainId})`);
const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
const contract = await factory.deploy();
const deployment = contract.deploymentTransaction();
console.log(`İşlem: ${deployment.hash}`);
await contract.waitForDeployment();
console.log(`SurplusPortions: ${await contract.getAddress()}`);
console.log('Sonraki adım: adresi explorer ile doğrula ve UI event okuyucusuna bağla.');
