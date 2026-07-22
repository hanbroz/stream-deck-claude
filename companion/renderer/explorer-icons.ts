const ICON_ROOT = "./assets/material-icons";

const folderIcons: Readonly<Record<string, string>> = {
  ".git": "folder-git.svg",
  ".github": "folder-github.svg",
  "assets": "folder-images.svg",
  "claude": "folder-claude.svg",
  "components": "folder-components.svg",
  "config": "folder-config.svg",
  "docs": "folder-docs.svg",
  "dist": "folder-dist.svg",
  "images": "folder-images.svg",
  "node_modules": "folder-node.svg",
  "packages": "folder-packages.svg",
  "plugin": "folder-plugin.svg",
  "plugins": "folder-plugin.svg",
  "public": "folder-public.svg",
  "scripts": "folder-scripts.svg",
  "src": "folder-src.svg",
  "test": "folder-test.svg",
  "tests": "folder-test.svg",
  "tools": "folder-tools.svg",
};

const exactFileIcons: Readonly<Record<string, string>> = {
  ".editorconfig": "editorconfig.svg",
  ".env": "settings.svg",
  ".env.local": "settings.svg",
  ".gitignore": "git.svg",
  "dockerfile": "docker.svg",
  "license": "license.svg",
  "makefile": "makefile.svg",
  "package.json": "npm.svg",
  "package-lock.json": "lock.svg",
  "pnpm-lock.yaml": "lock.svg",
  "yarn.lock": "lock.svg",
};

const extensionFileIcons: Readonly<Record<string, string>> = {
  bat: "command.svg",
  c: "c.svg",
  cc: "cpp.svg",
  cpp: "cpp.svg",
  cs: "csharp.svg",
  css: "css.svg",
  env: "settings.svg",
  fish: "command.svg",
  go: "go.svg",
  h: "c.svg",
  hpp: "cpp.svg",
  htm: "html.svg",
  html: "html.svg",
  java: "java.svg",
  jpeg: "image.svg",
  jpg: "image.svg",
  gif: "image.svg",
  ico: "image.svg",
  js: "javascript.svg",
  json: "json.svg",
  jsonc: "json.svg",
  jsx: "javascript.svg",
  less: "css.svg",
  lock: "lock.svg",
  md: "markdown.svg",
  mdx: "markdown.svg",
  mjs: "javascript.svg",
  png: "image.svg",
  pdf: "pdf.svg",
  ps1: "powershell.svg",
  psm1: "powershell.svg",
  py: "python.svg",
  rs: "rust.svg",
  sass: "css.svg",
  scss: "css.svg",
  sh: "command.svg",
  sql: "database.svg",
  svg: "svg.svg",
  ts: "typescript.svg",
  tsx: "typescript.svg",
  toml: "toml.svg",
  ttf: "font.svg",
  vue: "vue.svg",
  wav: "image.svg",
  webp: "image.svg",
  woff: "font.svg",
  woff2: "font.svg",
  xml: "xml.svg",
  yaml: "yaml.svg",
  yml: "yaml.svg",
};

function iconPath(fileName: string): string {
  return `${ICON_ROOT}/${fileName}`;
}

function extensionOf(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

/** Returns the vendored Material Icon Theme SVG used by an explorer row. */
export function explorerIconPath(name: string, kind: "directory" | "file"): string {
  if (kind === "directory") {
    return iconPath(folderIcons[name.toLowerCase()] ?? "folder-base.svg");
  }

  const normalizedName = name.toLowerCase();
  return iconPath(
    exactFileIcons[normalizedName] ??
      extensionFileIcons[extensionOf(normalizedName)] ??
      "document.svg"
  );
}

/** Uses VS Code-like chevrons while keeping the loading state explicit. */
export function explorerChevron(
  kind: "directory" | "file",
  expanded = false,
  loading = false
): string {
  if (kind !== "directory") {
    return "";
  }
  if (loading) {
    return "…";
  }
  return expanded ? "⌄" : "›";
}
