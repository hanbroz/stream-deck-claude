// The plugin manifest and package.json carry the version separately (the
// installer name comes from package.json, the release ZIP name from the
// manifest); a drift would ship two versions under one tag.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(
  readFileSync(new URL("../com.hanbroz.claude-usage.sdPlugin/manifest.json", import.meta.url), "utf8")
);
const expected = `${pkg.version}.0`;
if (manifest.Version !== expected) {
  console.error(
    `Version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.Version} (expected ${expected}).`
  );
  process.exit(1);
}
console.log(`Version check passed: ${pkg.version}`);
