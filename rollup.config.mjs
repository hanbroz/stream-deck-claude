import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = Boolean(process.env.ROLLUP_WATCH);
const pluginDir = "com.hanbroz.claude-usage.sdPlugin";

function plugins(emitModulePackage = false) {
  const configured = [
    typescript({ mapRoot: isWatching ? "./" : undefined }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    !isWatching && terser()
  ];

  if (emitModulePackage) {
    configured.push({
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      }
    });
  }
  return configured;
}

function config(input, file, emitModulePackage = false) {
  return {
    input,
    output: {
      file: `${pluginDir}/${file}`,
      format: "es",
      sourcemap: isWatching,
      sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
        url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href
    },
    plugins: plugins(emitModulePackage)
  };
}

function toolConfig(input, file) {
  return {
    input,
    output: {
      file,
      format: "es",
      sourcemap: isWatching
    },
    plugins: plugins()
  };
}

export default [
  config("src/plugin.ts", "bin/plugin.js", true),
  config("src/bridge/statusline-bridge.ts", "bridge/statusline-bridge.js"),
  config("src/bridge/install-cli.ts", "bridge/install-bridge.js"),
  toolConfig("scripts/render-previews.ts", "dist/tools/render-previews.js")
];
