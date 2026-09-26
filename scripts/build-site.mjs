import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(projectRoot, "web");
const outputRoot = path.join(projectRoot, "dist");
const runtimePath = path.join(projectRoot, "worker", "runtime.js");

const imageNames = ["komsu-firin.jpg", "moda-yemekhane.jpg", "aksam-kafe.jpg"];
const [html, css, js, p256, runtime, hosting, ...imageBuffers] = await Promise.all([
  readFile(path.join(webRoot, "index.html"), "utf8"),
  readFile(path.join(webRoot, "styles.css"), "utf8"),
  readFile(path.join(webRoot, "app.js"), "utf8"),
  readFile(path.join(webRoot, "p256-device.js"), "utf8"),
  readFile(runtimePath, "utf8"),
  readFile(path.join(projectRoot, ".openai", "hosting.json"), "utf8"),
  ...imageNames.map(name => readFile(path.join(webRoot, "assets", name))),
]);
const images = Object.fromEntries(imageNames.map((name, index) => [name, imageBuffers[index].toString("base64")]));

const builtRuntime = runtime
  .replace("__PAGE_HTML__", JSON.stringify(html))
  .replace("__PAGE_CSS__", JSON.stringify(css))
  .replace("__PAGE_JS__", JSON.stringify(js))
  .replace("__P256_JS__", JSON.stringify(p256))
  .replace("__IMAGES_BASE64__", JSON.stringify(images));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "server"), { recursive: true });
await mkdir(path.join(outputRoot, ".openai"), { recursive: true });
await writeFile(path.join(outputRoot, "server", "index.js"), builtRuntime);
await writeFile(path.join(outputRoot, ".openai", "hosting.json"), hosting);
console.log(`Sites Worker built: ${path.join(outputRoot, "server", "index.js")}`);
