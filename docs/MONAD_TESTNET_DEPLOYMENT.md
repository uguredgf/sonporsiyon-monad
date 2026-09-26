# Monad Testnet deployment

Verified on 26 September 2026 against Monad Testnet chain ID `10143`.

- Contract: [`0x3727Cc6eBc90C0a05Acff9475A507FBFf7D19e9f`](https://testnet.monadvision.com/address/0x3727Cc6eBc90C0a05Acff9475A507FBFf7D19e9f)
- Deployment transaction: [`0x2deb9d5c...2378db9`](https://testnet.monadvision.com/tx/0x2deb9d5c51f6ea074f19968ab84592e769226e239b93967a71d71bf162378db9)
- Runtime bytecode: 6,908 bytes, confirmed with `eth_getCode`
- P-256 verifier: Monad EIP-7951 precompile at `0x0100`

The reproducible `npm run e2e:monad` check creates a batch, claims with one
P-256 device key, releases it through the relayer, claims another slot with a
second device key, and redeems that slot through the provider. Its latest
transaction hashes should be recorded below after every intentional redeploy.

## Verified flow

- Batch create: [`0x6b0126de...0c272a`](https://testnet.monadvision.com/tx/0x6b0126de99d2f6c701082f2bd66f453df6f0a3b87fb0990a35e544bfe10c272a)
- First P-256 claim: [`0xd3f13421...76d3d4`](https://testnet.monadvision.com/tx/0xd3f13421738b338fdd47d36ab675898cdde7ff3e427e75c090341ff0c876d3d4)
- P-256 release: [`0x7b79c6d0...d7da7c`](https://testnet.monadvision.com/tx/0x7b79c6d0aa43bd97bdcbfa072826f869c8d7a0c4b899312f1934db2d88d7da7c)
- Second P-256 claim: [`0x49939d61...f41477`](https://testnet.monadvision.com/tx/0x49939d619a2025a82f071aa837bf618a0868ebc0e2f68340db52b5defcf41477)
- Provider redeem: [`0x49104811...36b008`](https://testnet.monadvision.com/tx/0x4910481110aa46415bd714c98bb683d6cd7e301fe15c1d95d23a3da51936b008)

These hashes prove the contract path independently of the local UI. The web
application uses the same contract methods when its local Monad environment
variables are present.

## Browser flow proof

The headless browser test also completed the visible business and consumer
workflow against the configured server:

- Publish from business screen: [`0x94068a8f...2aa944`](https://testnet.monadvision.com/tx/0x94068a8fa202540730249dc8b9290afb1af4ae454543dcabc410c3af1b2aa944)
- P-256 claim from consumer screen: [`0x4cbcaf30...af117c`](https://testnet.monadvision.com/tx/0x4cbcaf30456696d17e7326f4c443d6693496749e7830fe7eee59b8c393af117c)
- Code redemption from business screen: [`0x653f9164...adf53b`](https://testnet.monadvision.com/tx/0x653f9164d5a32230c06bbe7983004cbfd6991cca6e426177da9c32700badf53b)
