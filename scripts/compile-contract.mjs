import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(projectRoot, "contracts", "SurplusPortions.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "SurplusPortions.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const item of output.errors || []) console[item.severity === "error" ? "error" : "warn"](item.formattedMessage);
if ((output.errors || []).some(item => item.severity === "error")) process.exit(1);

const artifact = output.contracts["SurplusPortions.sol"].SurplusPortions;
const buildRoot = path.join(projectRoot, "build");
await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await Promise.all([
  writeFile(path.join(buildRoot, "SurplusPortions.abi.json"), JSON.stringify(artifact.abi, null, 2)),
  writeFile(path.join(buildRoot, "SurplusPortions.bin"), artifact.evm.bytecode.object),
  writeFile(path.join(buildRoot, "SurplusPortions.runtime.bin"), artifact.evm.deployedBytecode.object),
]);
console.log(`SurplusPortions compiled (${artifact.evm.deployedBytecode.object.length / 2} deployed bytes).`);
