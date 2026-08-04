import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SlashCommand } from "../shared/slash-commands";

/**
 * The commands the composer's "/" menu offers — the same inventory the
 * interactive CLI lists: custom commands (`.claude/commands/*.md`), skills
 * (`.claude/skills/<name>/SKILL.md`), and every installed plugin's commands
 * and skills (namespaced `plugin:name`). All of these are prompt expansions,
 * which `claude --print` executes.
 *
 * The full builtin roster, mirroring the terminal's "/" list. The CLI offers
 * no way to enumerate its own commands from print mode (/help replies "isn't
 * available in this environment" — probed), and blind-probing each candidate
 * is unsafe (/init, /login, … actually run), so this list is maintained by
 * hand; update it when the CLI adds commands.
 *
 * Entries the CLI cannot serve in print mode carry a "터미널 전용" tag —
 * picking one still gets the CLI's own polite refusal, never a hang.
 * /clear is handled by the Companion itself (new conversation).
 */
const TERMINAL_ONLY_BUILTINS: Array<[string, string]> = [
  ["add-dir", "작업 디렉터리 추가"],
  ["agents", "에이전트 관리"],
  ["bug", "버그 리포트 전송"],
  ["config", "설정 열기"],
  ["copy", "마지막 응답 클립보드 복사"],
  ["doctor", "설치 상태 진단"],
  ["export", "대화 내보내기"],
  ["help", "도움말"],
  ["hooks", "훅 관리"],
  ["ide", "IDE 연결"],
  ["install-github-app", "GitHub 앱 설치"],
  ["login", "계정 로그인"],
  ["logout", "로그아웃"],
  ["memory", "메모리(CLAUDE.md) 편집"],
  ["output-style", "출력 스타일 변경"],
  ["permissions", "권한 관리"],
  ["pr-comments", "PR 코멘트 조회"],
  ["privacy-settings", "개인정보 설정"],
  ["release-notes", "릴리스 노트"],
  ["resume", "이전 대화 재개 (Companion은 Code Start가 자동 재개)"],
  ["rewind", "체크포인트 되감기"],
  ["statusline", "상태줄 설정"],
  ["status", "연결 상태"],
  ["terminal-setup", "터미널 키 설정"],
  ["todos", "할 일 목록"],
  ["upgrade", "플랜 업그레이드"],
  ["vim", "Vim 입력 모드"]
];

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 대화 시작", source: "builtin" },
  // TUI-only as slash commands, but Claude Code also ships them as real
  // non-interactive subcommands, so the Companion runs `claude <name> …` and
  // prints the result. Kept in sync with BRIDGED_CLI_COMMANDS.
  { name: "plugin", description: "플러그인·마켓플레이스 관리 (CLI 실행)", source: "builtin" },
  { name: "mcp", description: "MCP 서버 관리 (CLI 실행)", source: "builtin" },
  // Probed working in print mode:
  // /compact declares supportsNonInteractive in the CLI and was verified end to
  // end: it summarizes, fires the SessionStart:compact hooks, and returns an
  // EMPTY result — the renderer posts its own notice so the turn is not blank.
  { name: "compact", description: "대화 컨텍스트 압축 (요약에 1분 내외)", source: "builtin" },
  { name: "usage", description: "구독 사용량 한도 확인", source: "builtin" },
  { name: "cost", description: "현재 세션 비용·사용량", source: "builtin" },
  { name: "context", description: "컨텍스트 사용량 분석", source: "builtin" },
  // Handled by the Companion itself. Each message spawns a fresh `claude
  // --print`, so Claude re-reads skills and plugins from disk every time and
  // has nothing to reload; what can go stale is this app's own "/" inventory,
  // which normally only rescans every 30s. These force that rescan now.
  { name: "reload-skills", description: "스킬·명령 목록 즉시 다시 읽기", source: "builtin" },
  { name: "reload-plugins", description: "플러그인·명령 목록 즉시 다시 읽기", source: "builtin" },
  // Read-only in this architecture: per-message runs take the model from the
  // composer dropdown, so /model <name> would not stick past one reply.
  { name: "model", description: "현재 모델 확인 (변경은 하단 Model 선택)", source: "builtin" },
  // Prompt-expansion builtins — they run as a normal agentic turn:
  { name: "init", description: "CLAUDE.md 초기화 생성", source: "builtin" },
  { name: "review", description: "코드 리뷰 실행", source: "builtin" },
  { name: "security-review", description: "보안 리뷰 실행", source: "builtin" },
  ...TERMINAL_ONLY_BUILTINS.map(([name, description]): SlashCommand => ({
    name,
    description: `${description} · 터미널 전용`,
    source: "builtin"
  }))
];

/** First `description:` line of the file's YAML frontmatter, if any. */
function frontmatterDescription(head: string): string | undefined {
  if (!head.startsWith("---")) {
    return undefined;
  }
  const end = head.indexOf("\n---", 3);
  const block = end === -1 ? head : head.slice(0, end);
  const match = /^description:\s*(.+)$/mu.exec(block);
  return match?.[1].trim().replace(/^["']|["']$/gu, "");
}

async function describeFile(filePath: string): Promise<string | undefined> {
  try {
    return frontmatterDescription((await readFile(filePath, "utf8")).slice(0, 2048));
  } catch {
    return undefined; // a vanished/unreadable file still lists by name
  }
}

/** `<directory>/*.md` → commands. A namespace prefixes names as `ns:name`. */
async function scanCommandDirectory(
  directory: string,
  source: SlashCommand["source"],
  namespace?: string
): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    // ponytail: top-level *.md only; nested namespaced command dirs can come
    // later if anyone actually uses them.
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const bare = entry.name.slice(0, -".md".length);
    commands.push({
      name: namespace ? `${namespace}:${bare}` : bare,
      description: await describeFile(path.join(directory, entry.name)),
      source
    });
  }
  return commands;
}

/** `<directory>/<name>/SKILL.md` → commands, like the CLI's skill slashes. */
async function scanSkillDirectory(
  directory: string,
  source: SlashCommand["source"],
  namespace?: string
): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const description = await describeFile(path.join(directory, entry.name, "SKILL.md"));
    if (description === undefined) {
      // No readable SKILL.md → not a skill folder.
      continue;
    }
    commands.push({
      name: namespace ? `${namespace}:${entry.name}` : entry.name,
      description,
      source
    });
  }
  return commands;
}

/** Installed plugins from the CLI's own manifest: name → installPath. */
async function installedPlugins(configDir: string): Promise<Array<{ name: string; installPath: string }>> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(configDir, "plugins", "installed_plugins.json"), "utf8")
    ) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const plugins: Array<{ name: string; installPath: string }> = [];
    for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
      const installPath = installs?.[0]?.installPath;
      if (typeof installPath === "string" && installPath.length > 0) {
        plugins.push({ name: key.split("@")[0], installPath });
      }
    }
    return plugins;
  } catch {
    return []; // no plugins installed (or unreadable manifest)
  }
}

export async function listSlashCommands(options: {
  configDir: string;
  projectRoot: string;
}): Promise<SlashCommand[]> {
  const plugins = await installedPlugins(options.configDir);
  const groups = await Promise.all([
    scanCommandDirectory(path.join(options.projectRoot, ".claude", "commands"), "project"),
    scanSkillDirectory(path.join(options.projectRoot, ".claude", "skills"), "project"),
    scanCommandDirectory(path.join(options.configDir, "commands"), "user"),
    scanSkillDirectory(path.join(options.configDir, "skills"), "user"),
    ...plugins.flatMap((plugin) => [
      scanCommandDirectory(path.join(plugin.installPath, "commands"), "plugin", plugin.name),
      scanSkillDirectory(path.join(plugin.installPath, "skills"), "plugin", plugin.name)
    ])
  ]);

  // Builtins first, then project → user → plugins; first occurrence of a
  // name wins (project shadows user shadows plugins).
  const seen = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  const merged = [...BUILTIN_COMMANDS];
  for (const command of groups.flat()) {
    if (!seen.has(command.name)) {
      seen.add(command.name);
      merged.push(command);
    }
  }
  return merged;
}
