import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const companionRoot = path.join(projectRoot, "companion");
const outputRoot = path.join(projectRoot, "dist", "companion", "app");

const requiredFiles = {
  "main process entry": path.join(companionRoot, "main", "main.ts"),
  "preload entry": path.join(companionRoot, "preload", "index.ts"),
  "renderer HTML": path.join(companionRoot, "renderer", "index.html"),
};

for (const [label, filePath] of Object.entries(requiredFiles)) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing Companion ${label}: ${path.relative(projectRoot, filePath)}`);
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "renderer"), { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [requiredFiles["main process entry"]],
  outfile: path.join(outputRoot, "main", "main.mjs"),
  format: "esm",
  external: ["electron", "node-pty"],
});
await writeFile(
  path.join(outputRoot, "main.cjs"),
  'import("./main/main.mjs").catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n',
  "utf8"
);

await build({
  ...common,
  entryPoints: [requiredFiles["preload entry"]],
  outfile: path.join(outputRoot, "preload", "index.cjs"),
  format: "cjs",
  external: ["electron"],
});

const rendererEntry = path.join(companionRoot, "renderer", "index.ts");
if (existsSync(rendererEntry)) {
  await build({
    bundle: true,
    sourcemap: true,
    target: "chrome128",
    platform: "browser",
    entryPoints: [rendererEntry],
    outfile: path.join(outputRoot, "renderer", "index.js"),
    logLevel: "info",
  });
}

await cp(path.join(companionRoot, "renderer"), path.join(outputRoot, "renderer"), {
  recursive: true,
  filter(source) {
    return !source.endsWith(".ts") && !source.endsWith(".tsx");
  },
});

console.log(`Companion app built at ${path.relative(projectRoot, outputRoot)}`);
