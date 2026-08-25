# Code Deck for Claude Code

[English](#english) · [한국어](#korean) · [简体中文](#chinese) · [日本語](#japanese)

A Windows Stream Deck plugin for controlling Claude Code and displaying usage and session status directly on Stream Deck keys.

> [!NOTE]
> **Unofficial tool / 비공식 도구** — Code Deck for Claude Code is an independent third-party tool. It is not affiliated with, endorsed by, or sponsored by Anthropic, PBC or CORSAIR (Elgato). "Claude" and "Claude Code" are trademarks of Anthropic, PBC; "Stream Deck" is a trademark of CORSAIR. Using it requires your own Claude Code installation and account, and your Claude Code usage remains subject to Anthropic's terms. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Preview

| Stream Deck keys | Code Start settings |
| --- | --- |
| ![Claude actions displayed on Stream Deck keys](docs/images/SDCLAUDE.png) | ![Code Start project settings in Stream Deck](docs/images/SDCLAUDE_SETTING.png) |

---

<a id="english"></a>

## English

### Overview

Code Deck for Claude Code displays Claude Code subscription limits, launches configured projects, and tracks the context usage and activity of each launched session.

> [!WARNING]
> `Code Start` intentionally launches `claude --dangerously-skip-permissions`. Use it only with folders and repositories you trust.

### Actions

- **5-Hour Usage**: Displays the used percentage and reset countdown for the five-hour window.
- **Weekly Usage**: Displays the used percentage and reset countdown for the seven-day window.
- **Code Start**: Opens Code Deck Companion in a configured project folder, starts Claude Code inside that app, and displays that session's project name, current model, context usage bar, and activity status.

Each action has a separate UUID and can be placed on an independent key. A Code Start placement persists its session binding, so moving a running button to another key keeps the same context display.

The Code Start model text changes color according to session activity:

- Green: Claude Code is running.
- Red: Claude Code is idle.
- Blue: Claude Code is waiting for your answer.
- `Closed`: No app is running for this project — never started, already ended, or stopped reporting. The model line and context bar appear only while an app is actually open.

### Data source

Claude Code provides `rate_limits.five_hour` and `rate_limits.seven_day` through its status-line JSON. When no other status-line command is configured, the included bridge requests a one-second status-line refresh, prevents a stale session from lowering a newer value within the same reset window, stores only those fields in `%LOCALAPPDATA%\ClaudeUsageDeck\usage.json`, and forwards the original input to any pre-existing status-line command recorded from earlier installs. When another command already owns Claude Code's single status-line slot, the installer leaves that command in place and only installs the lifecycle hooks used by Code Start.

The plugin never reads `.claude/.credentials.json`.

If OMC HUD or another status-line command already owns Claude Code's single status-line slot, ClaudeUsageDeck preserves it. Code Start lifecycle hooks continue to work. Usage keys first read OMC's fresh Anthropic usage cache (when present), so the 5-hour and weekly values stay aligned without replacing OMC's command; if no fresh cache is available they show `STATUSLINE BUSY` rather than claiming stale data is live.

### Install and use

Requirements: Windows 10 or later, Stream Deck 7.1 or later, Claude Code, and Windows Terminal. The Companion installer checks for `wt.exe`; if it is missing, it runs `winget install --id Microsoft.WindowsTerminal -e --source winget --silent --accept-package-agreements --accept-source-agreements`, rechecks, and aborts with a manual Microsoft install link if Windows Terminal still cannot be confirmed.

1. Download the Windows release ZIP from the [latest GitHub release](https://github.com/hanbroz/stream-deck-claude/releases/latest), extract it, and run `Install.cmd`.
2. In Stream Deck, drag a usage action or `Code Start` onto a key.
3. For Code Start, enter a project name, select the Claude Code folder, and save the settings.
4. Press the key once. Code Deck Companion opens for that folder, the plugin backs up `~/.claude/settings.json`, installs the bridge and lifecycle hooks, and preserves existing status-line commands and hooks.
5. Send one Claude Code message. Usage keys display current percentages and reset countdowns, while Code Start displays the launched session's current model and context usage bar.

When Companion opens, it automatically starts Claude in structured streaming mode (`claude --dangerously-skip-permissions --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose`) in the configured project root. Only Claude conversation text is rendered in the read-only `Claude Console`; prompts and clipboard images are sent only from the bottom composer. Press Enter or the `전송` button to submit a message; the renderer waits for the Companion IPC write acknowledgement and reports a failed send in the console/toast instead of silently dropping it. The explorer also includes a terminal-open action that runs `wt.exe -d <project-folder>` as a separate external terminal. File operations stay inside the configured root.

Code Start and Companion verify a saved `/resume` ID against a matching `<session-id>.jsonl` transcript under Claude Code's local projects store (`%CLAUDE_CONFIG_DIR%\projects` or `~/.claude/projects`). A missing transcript is treated as “no previous session”: the stale pointer is removed when Code Start owns it, and Companion starts fresh without a warning even when an older plugin still passes the stale ID. If the transcript exists but Claude still cannot load it, Companion keeps the normal recovery/error path so the failed resume remains visible.

The explorer follows the VS Code tree convention: directories use `›`/`⌄` chevrons, nested rows keep their indentation, and files use a vendored subset of the [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme/tree/main/icons). The SVG subset and its MIT notice are packaged locally under `companion/renderer/assets/material-icons`, so installed Companion windows do not depend on a network request for icons.

The Companion renderer follows the imported Claude Design screen in [`companion/ClaudeCodeApp.dc.html`](companion/ClaudeCodeApp.dc.html): an orange-accented Visual Studio-style title bar, project explorer, session tabs, terminal split, context menu, and chat dock. The Electron renderer translates that design into regular DOM/CSS while keeping Claude's structured conversation stream on pipes (so the read-only console never receives terminal echo) and retaining PTY support for the separate project terminal.

The explorer/workspace boundary, console/embedded-terminal boundary, and workspace/chat boundary each have a draggable Split handle. Their sizes are constrained to keep both sides usable, can also be adjusted with arrow keys/Home/End after focusing a handle, and are remembered locally for the next Companion launch.

The maintained visual contract is documented in [`DESIGN.md`](DESIGN.md). The renderer keeps the reference's 40px title bar, 36px session tabs, 260px explorer, Cascadia Code console, optional embedded terminal split, bottom composer dock, and accent focus states; runtime-only controls are kept in compact explorer actions or context menus so they do not displace the reference layout. The Claude output area is selectable/read-only, while the composer accepts Korean text, clipboard images, Enter-to-send, and Shift+Enter newlines.

The settings button in the title bar opens a colour theme picker: seven dark themes (`Claude Dark`, Catppuccin Mocha, Tokyo Night, Nord, Dracula, One Dark Pro, Gruvbox Dark) and five light ones (Catppuccin Latte, Solarized Light, GitHub Light, One Light, Gruvbox Light). `Claude Dark` is the reference palette and stays the default. The choice applies immediately, recolours the embedded terminal along with the rest of the window, and is remembered for the next launch. Every rule in the stylesheet resolves to a palette token, so a theme is one block of 23 colours; contrast is pinned by tests at WCAG AA for the light themes and 3.6:1 for the dark ones, which is why a few of the upstream palettes are darker here than in their editor originals — those values are picked for syntax inside a code pane, not for UI labels on window chrome.

If Code Start still opens the previous dark console window with a native `File / Edit / View / Window` menu, the old Companion binary is still being used. For a released/installed plugin, install the matching `Code Deck Companion Setup *.exe` once and restart Stream Deck. During local development you do not need to reinstall for every change: run `npm run companion:dir`, keep the plugin linked with `npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin`, and Code Start resolves `dist/companion/win-unpacked/Code Deck Companion.exe` before the per-user installed copy. `CLAUDE_DECK_COMPANION_PATH` can also point Stream Deck at a specific unpacked executable.

If the title shows `.` or the embedded terminal says `[project terminal API unavailable]`, the Companion preload or plugin process is stale. Rebuild the Companion, restart the linked plugin, close any old Companion window, and press Code Start again:

```powershell
npm run companion:dir
npm exec -- streamdeck restart com.hanbroz.claude-usage
```

For the current Claude Console input/output investigation, see [`docs/CLAUDE_COMPANION_HANDOFF_20260722.md`](docs/CLAUDE_COMPANION_HANDOFF_20260722.md). It records the verified commits, test evidence, runtime boundaries, and the exact prompt for a fresh Claude Code session.

Usage keys check the local cache every second and skip unchanged images. These refreshes do not send Claude requests or consume usage. The value can still trail the web dashboard until Claude Code publishes a newer `rate_limits` payload; if a reset time passes first, the key displays `REFRESH` instead of a stale percentage.

The composer starts on **Sonnet** at **medium** effort. Companion runs one `claude --print --resume` process per message, so the default is paid on every turn rather than once, and Opus costs roughly five times as much against the plan's rate limit. Pick a different model or effort in the composer whenever a task needs it — the choice applies from the next message and is remembered for that folder. The conversation is compacted automatically once it passes 45% of the context window, because every later turn re-sends the whole prefix; Esc stops a reply without triggering a compaction, and releases anything queued behind it.

### Local development

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run validate
npm run verify:bridge
npm run companion:test
npm run companion:build
npm run companion:dir
npm run companion:package
npm run pack
npm run release:windows
```

For local Stream Deck development, link the plugin folder with:

```powershell
npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin
```

`npm run preview` writes actual-account SVG previews to `dist/previews` after a successful build.

`npm run release:windows` runs the verification pipeline, builds the Companion installer, packages the Stream Deck plugin, and creates a versioned Windows recovery ZIP containing the Companion installer, `.streamDeckPlugin`, Korean installation guide, launcher, and SHA-256 checksums. The Companion NSIS installer opens the bundled Stream Deck plugin after Companion files are installed.

Building the Companion installer uses the `node-pty` prebuild that ships in the package (`prebuilds/win32-x64`). `node-pty` is a `node-addon-api` (Node-API) module, and Node-API binaries are ABI-stable, so they load in Electron exactly as they do in Node — no source rebuild, and the build machine needs no Visual Studio, only access to the Electron download cache or network. End users need neither.

`npm run companion:dir` is the fast local-development path: it produces the same unpacked app the installer wraps, so renderer/main changes can be picked up without reinstalling the Companion. `npm run companion:rebuild` rebuilds `node-pty` from source and is only needed if a future Electron or `node-pty` version stops shipping a usable Node-API prebuild; it requires a Visual Studio that `node-gyp` can detect, which it cannot on VS 18.

### Checking which build is running

Both halves name their own build, so a stale binary — or a plugin that was never
restarted after a rebuild — is visible at a glance:

- **Companion**: the title bar shows `ver. yyyy.MM.dd.HH.mm`, its build time.
- **Plugin**: the first log line in `com.hanbroz.claude-usage.sdPlugin/logs/` reads
  `Claude actions registered: v<manifest version> (build yyyy.MM.dd.HH.mm); …`.

A rebuilt plugin bundle only takes effect once Stream Deck restarts the plugin, so
compare that stamp against the build time before trusting a test result. The two
stamps should match after a full `release:windows`.

### Privacy and local data

- The plugin does not read Claude credentials.
- Prompts and assistant responses are never persisted by the bridge.
- Usage and context caches are stored locally under `%LOCALAPPDATA%\ClaudeUsageDeck`.
- Project folders and button settings remain in the local Stream Deck profile.

[Back to language selection](#claude-for-stream-deck)

---

<a id="korean"></a>

## 한국어

### 개요

Code Deck for Claude Code은 Claude Code 구독 사용량을 표시하고, 설정한 프로젝트에서 Claude Code를 실행하며, 실행한 각 세션의 컨텍스트 사용량과 활동 상태를 Stream Deck 버튼에 표시하는 Windows용 플러그인입니다. Anthropic·CORSAIR와 무관한 비공식 서드파티 도구입니다.

> [!WARNING]
> `Code Start`는 의도적으로 `claude --dangerously-skip-permissions`를 실행합니다. 신뢰할 수 있는 폴더와 저장소에서만 사용하십시오.

### 기능

- **5-Hour Usage**: 5시간 한도의 사용률과 초기화까지 남은 시간을 표시합니다.
- **Weekly Usage**: 7일 한도의 사용률과 초기화까지 남은 시간을 표시합니다.
- **Code Start**: 설정한 프로젝트 폴더에서 터미널과 Claude Code를 실행하고, 해당 세션의 프로젝트명·현재 모델·컨텍스트 사용량 막대·활동 상태를 표시합니다.

각 기능은 별도의 UUID를 사용하므로 서로 다른 버튼에 자유롭게 배치할 수 있습니다. Code Start는 세션 연결 정보를 유지하므로, 실행 중인 버튼을 다른 칸으로 옮겨도 동일한 컨텍스트 정보를 계속 표시합니다.

Code Start의 모델 텍스트 색상은 세션 상태에 따라 변경됩니다.

- 녹색: Claude Code 실행 중
- 빨간색: Claude Code 대기 중
- 파란색: Claude Code가 사용자 답변을 기다리는 중
- `Closed`: 이 프로젝트로 실행 중인 앱이 없음 — 아직 실행하지 않았거나, 종료되었거나, 상태 보고가 끊긴 경우. 모델 텍스트와 컨텍스트 막대는 앱이 실제로 열려 있을 때만 표시됩니다

### 데이터 출처

Claude Code는 상태 표시줄 JSON을 통해 `rate_limits.five_hour`와 `rate_limits.seven_day`를 제공합니다. 다른 상태 표시줄 명령이 없을 때 포함된 브리지는 상태 표시줄을 1초마다 갱신하도록 요청하고, 같은 초기화 구간에서 오래된 세션의 낮은 값이 최신 높은 값을 덮어쓰지 못하게 병합합니다. 이 필드만 `%LOCALAPPDATA%\ClaudeUsageDeck\usage.json`에 저장하며, 이전 설치에서 기록한 원본 명령이 있는 경우에만 원본 입력을 그대로 전달합니다. OMC HUD처럼 다른 명령이 현재 슬롯을 사용 중이면 해당 명령을 바꾸거나 감싸지 않습니다. OMC가 제공하는 최신 Anthropic 사용량 캐시가 있으면 5시간·주간 값에 사용하고, 없거나 오래되었으면 `STATUSLINE BUSY`를 표시합니다.

플러그인은 `.claude/.credentials.json`을 읽지 않습니다.

### 설치 및 사용

요구 사항: Windows 10 이상, Stream Deck 7.1 이상

1. [최신 GitHub 릴리스](https://github.com/hanbroz/stream-deck-claude/releases/latest)에서 `com.hanbroz.claude-usage.streamDeckPlugin`을 내려받아 더블클릭하여 설치합니다.
2. Stream Deck에서 원하는 사용량 기능 또는 `Code Start`를 버튼에 배치합니다.
3. Code Start의 경우 프로젝트명을 입력하고 Claude Code를 실행할 폴더를 선택한 다음 설정을 저장합니다.
4. 버튼을 한 번 누릅니다. 플러그인은 `~/.claude/settings.json`을 백업하고 상태 표시줄 브리지와 수명 주기 훅을 설치하며, 기존 상태 표시줄 명령과 훅은 보존합니다.
5. Claude Code에서 메시지를 한 번 전송합니다. 사용량 버튼에는 현재 사용률과 초기화 시간이, Code Start에는 실행한 세션의 현재 모델·컨텍스트 사용량 막대가 표시됩니다.

Companion 타이틀바의 설정 버튼에서 컬러 테마를 고를 수 있습니다. 다크 7종(`Claude Dark`, Catppuccin Mocha, Tokyo Night, Nord, Dracula, One Dark Pro, Gruvbox Dark)과 라이트 5종(Catppuccin Latte, Solarized Light, GitHub Light, One Light, Gruvbox Light)이 있으며, 기본값인 `Claude Dark`는 기존 화면 그대로입니다. 선택은 즉시 적용되고 내장 터미널 색까지 함께 바뀌며 다음 실행에도 유지됩니다.

Usage 버튼은 로컬 캐시를 1초마다 확인하고 값이 같으면 이미지를 다시 전송하지 않습니다. 이 갱신은 Claude 요청을 보내거나 사용량을 소비하지 않습니다. 다만 Claude Code가 새 `rate_limits` 값을 제공하기 전까지 웹 화면보다 늦을 수 있으며, 새 데이터보다 초기화 시각이 먼저 지나면 오래된 백분율 대신 `REFRESH`가 표시됩니다.

컴포저의 기본값은 **Sonnet · medium**입니다. Companion은 메시지 한 건마다 `claude --print --resume` 프로세스를 새로 띄우므로 기본값이 한 번이 아니라 매 턴 지불되며, Opus는 요금제 한도 대비 약 5배를 소모합니다. 필요한 작업에서는 컴포저에서 모델과 effort를 바꾸면 됩니다 — 다음 메시지부터 적용되고 해당 폴더에 기억됩니다. 대화는 컨텍스트 창의 45%를 넘으면 자동으로 압축됩니다. 이후의 모든 턴이 프리픽스 전체를 다시 보내기 때문입니다. Esc로 응답을 중단하면 압축이 발생하지 않으며, 뒤에 예약된 메시지도 함께 취소됩니다.

### 로컬 개발

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run validate
npm run verify:bridge
npm run pack
npm run companion:dir
npm run release:windows
```

로컬 Stream Deck 개발 환경에서는 다음 명령으로 플러그인 폴더를 연결합니다.

```powershell
npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin
```

빌드가 성공한 후 `npm run preview`를 실행하면 실제 계정 데이터를 이용한 SVG 미리보기가 `dist/previews`에 생성됩니다.

`npm run release:windows`는 전체 검증 절차를 실행하고 `.streamDeckPlugin` 설치 파일, 한국어 설치 안내서, 실행 도구, SHA-256 체크섬이 포함된 버전별 Windows 복구 ZIP을 생성합니다.

### 실행 중인 빌드 확인

앱과 플러그인 양쪽이 자신의 빌드를 밝히므로, 오래된 실행본이나 재빌드 후 재시작하지
않은 플러그인을 바로 알아볼 수 있습니다.

- **Companion**: 창 타이틀바에 빌드 시각이 `ver. yyyy.MM.dd.HH.mm` 형식으로 표시됩니다.
- **플러그인**: `com.hanbroz.claude-usage.sdPlugin/logs/`의 첫 로그 줄이
  `Claude actions registered: v<manifest 버전> (build yyyy.MM.dd.HH.mm); …` 형태입니다.

재빌드한 플러그인 번들은 Stream Deck이 플러그인을 재시작해야 적용되므로, 테스트 결과를
신뢰하기 전에 이 값이 빌드 시각과 같은지 확인하십시오. `release:windows`를 완전히 실행한
뒤에는 두 값이 일치합니다.

### 개인정보 및 로컬 데이터

- 플러그인은 Claude 인증 정보를 읽지 않습니다.
- 프롬프트와 Claude의 답변은 브리지에 저장되지 않습니다.
- 사용량 및 컨텍스트 캐시는 `%LOCALAPPDATA%\ClaudeUsageDeck` 아래에 로컬로 저장됩니다.
- 프로젝트 폴더와 버튼 설정은 로컬 Stream Deck 프로필에 유지됩니다.

[언어 선택으로 돌아가기](#claude-for-stream-deck)

---

<a id="chinese"></a>

## 简体中文

### 概述

Code Deck for Claude Code 是一款 Windows Stream Deck 插件（非官方第三方工具，与 Anthropic、CORSAIR 无关），可显示 Claude Code 订阅用量、启动已配置的项目，并在 Stream Deck 按键上显示每个已启动会话的上下文用量和活动状态。

> [!WARNING]
> `Code Start` 会有意执行 `claude --dangerously-skip-permissions`。请仅在您信任的文件夹和代码仓库中使用此功能。

### 功能

- **5-Hour Usage**：显示五小时限额的已用百分比和重置倒计时。
- **Weekly Usage**：显示七天限额的已用百分比和重置倒计时。
- **Code Start**：在指定项目文件夹中打开终端并启动 Claude Code，同时显示该会话的项目名称、当前模型、上下文用量进度条以及活动状态。

每个功能使用独立的 UUID，因此可以放置在不同按键上。Code Start 会保留会话绑定，即使在运行期间将按键移动到其他位置，也能继续显示相同的上下文信息。

Code Start 的模型文字颜色会根据会话状态变化：

- 绿色：Claude Code 正在运行。
- 红色：Claude Code 处于空闲状态。
- 蓝色：Claude Code 正在等待您的回答。
- `Closed`：该项目没有正在运行的应用 —— 尚未启动、已经结束，或状态上报已中断。模型文字与上下文进度条仅在应用实际打开时显示。

### 数据来源

Claude Code 通过状态栏 JSON 提供 `rate_limits.five_hour` 和 `rate_limits.seven_day`。没有其他状态栏命令时，内置桥接程序请求每秒刷新状态栏，并防止同一重置窗口中旧会话的较低值覆盖较新的较高值；它只把这些字段保存到 `%LOCALAPPDATA%\ClaudeUsageDeck\usage.json`，并仅在旧安装记录过原始命令时转发原始输入。如果 OMC HUD 等其他命令占用当前槽位，安装程序不会替换或包装该命令；存在新鲜的 OMC Anthropic 用量缓存时优先显示其数据，否则显示 `STATUSLINE BUSY`。

本插件不会读取 `.claude/.credentials.json`。

### 安装与使用

系统要求：Windows 10 或更高版本，以及 Stream Deck 7.1 或更高版本。

1. 从 [GitHub 最新版本](https://github.com/hanbroz/stream-deck-claude/releases/latest)下载 `com.hanbroz.claude-usage.streamDeckPlugin`，然后双击安装。
2. 在 Stream Deck 中，将需要的用量功能或 `Code Start` 拖放到按键上。
3. 使用 Code Start 时，输入项目名称，选择要运行 Claude Code 的文件夹，然后保存设置。
4. 按一次按键。插件会备份 `~/.claude/settings.json`，安装状态栏桥接程序和生命周期钩子，并保留已有的状态栏命令和钩子。
5. 在 Claude Code 中发送一条消息。用量按键会显示当前百分比和重置倒计时，Code Start 则会显示已启动会话的当前模型和上下文用量进度条。

用量按键每秒检查一次本地缓存，并跳过未变化的图像。这不会发送 Claude 请求，也不会消耗用量。在 Claude Code 发布新的 `rate_limits` 数据前，该值仍可能落后于网页；如果重置时间先到，按键会显示 `REFRESH`，而不是过期的百分比。

输入框默认使用 **Sonnet · medium**。Companion 每条消息都会新建一个 `claude --print --resume` 进程，因此默认值是每轮支付而非只付一次，而 Opus 对套餐额度的消耗约为五倍。需要时可在输入框中更换模型或 effort — 从下一条消息起生效，并会为该文件夹记住选择。对话超过上下文窗口的 45% 时会自动压缩，因为之后的每一轮都会重新发送整个前缀。按 Esc 中断回复不会触发压缩，并会一并取消排队中的消息。

### 本地开发

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run validate
npm run verify:bridge
npm run pack
npm run companion:dir
npm run release:windows
```

进行本地 Stream Deck 开发时，使用以下命令链接插件文件夹：

```powershell
npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin
```

构建成功后，`npm run preview` 会将基于实际账户数据的 SVG 预览写入 `dist/previews`。

`npm run release:windows` 会执行完整验证流程，并生成带版本号的 Windows 恢复 ZIP，其中包含 `.streamDeckPlugin` 安装包、韩文安装指南、启动工具和 SHA-256 校验值。

### 隐私与本地数据

- 插件不会读取 Claude 凭据。
- 桥接程序不会保存提示词或 Claude 的回答。
- 用量和上下文缓存仅存储在本机的 `%LOCALAPPDATA%\ClaudeUsageDeck` 目录下。
- 项目文件夹和按键设置保留在本地 Stream Deck 配置文件中。

[返回语言选择](#claude-for-stream-deck)

---

<a id="japanese"></a>

## 日本語

### 概要

Code Deck for Claude Codeは、Claude Codeのサブスクリプション使用量を表示し、設定したプロジェクトでClaude Codeを起動して、各セッションのコンテキスト使用量と稼働状態をStream Deckのキーに表示するWindowsプラグインです（Anthropic・CORSAIRとは無関係の非公式サードパーティツールです）。

> [!WARNING]
> `Code Start`は意図的に`claude --dangerously-skip-permissions`を実行します。信頼できるフォルダーとリポジトリでのみ使用してください。

### 機能

- **5-Hour Usage**：5時間枠の使用率とリセットまでの残り時間を表示します。
- **Weekly Usage**：7日間枠の使用率とリセットまでの残り時間を表示します。
- **Code Start**：指定したプロジェクトフォルダーでターミナルとClaude Codeを起動し、そのセッションのプロジェクト名、現在のモデル、コンテキスト使用量バー、稼働状態を表示します。

各機能は個別のUUIDを使用するため、それぞれ別のキーに配置できます。Code Startはセッションとの紐付けを保持するため、実行中のキーを別の位置へ移動しても同じコンテキスト情報を表示し続けます。

Code Startのモデルテキストは、セッションの状態に応じて色が変わります。

- 緑：Claude Codeが実行中です。
- 赤：Claude Codeが待機中です。
- 青：Claude Codeがユーザーの回答を待っています。
- `Closed`：このプロジェクトで実行中のアプリがありません（未起動、終了済み、または状態報告が途絶えた場合）。モデルテキストとコンテキストバーは、アプリが実際に開いているときだけ表示されます。

### データソース

Claude CodeはステータスラインJSONを通じて`rate_limits.five_hour`と`rate_limits.seven_day`を提供します。他のステータスラインコマンドがない場合、同梱のブリッジはステータスラインを1秒ごとに更新するよう要求し、同じリセット期間で古いセッションの低い値が新しい高い値を上書きしないようにします。これらのフィールドだけを`%LOCALAPPDATA%\ClaudeUsageDeck\usage.json`に保存し、以前のインストールで記録した元のコマンドがある場合だけ入力を転送します。OMC HUDなど別のコマンドがスロットを使用中の場合は置き換えません。新鮮なOMC Anthropic用量キャッシュがあればその値を優先し、なければ`STATUSLINE BUSY`を表示します。

このプラグインは`.claude/.credentials.json`を読み取りません。

### インストールと使用方法

必要環境：Windows 10以降、Stream Deck 7.1以降

1. [最新のGitHubリリース](https://github.com/hanbroz/stream-deck-claude/releases/latest)から`com.hanbroz.claude-usage.streamDeckPlugin`をダウンロードし、ダブルクリックしてインストールします。
2. Stream Deckで、使用量機能または`Code Start`をキーに配置します。
3. Code Startでは、プロジェクト名を入力し、Claude Codeを実行するフォルダーを選択して設定を保存します。
4. キーを一度押します。プラグインは`~/.claude/settings.json`をバックアップし、ステータスラインブリッジとライフサイクルフックをインストールします。既存のステータスラインコマンドとフックは保持されます。
5. Claude Codeでメッセージを1件送信します。使用量キーには現在の割合とリセットまでの残り時間が、Code Startには起動したセッションの現在のモデルとコンテキスト使用量バーが表示されます。

使用量キーはローカルキャッシュを1秒ごとに確認し、画像が変わらない場合は再送しません。この更新はClaudeへのリクエストを送信せず、使用量も消費しません。Claude Codeが新しい`rate_limits`データを公開するまではWeb画面より遅れる場合があり、先にリセット時刻を過ぎた場合は古い割合の代わりに`REFRESH`が表示されます。

コンポーザーの既定は **Sonnet · medium** です。Companionはメッセージごとに `claude --print --resume` プロセスを新しく起動するため、既定値は一度ではなく毎ターン支払われ、Opusはプランのレート制限に対しておよそ5倍を消費します。必要な作業ではコンポーザーでモデルやeffortを変更してください — 次のメッセージから適用され、そのフォルダーに記憶されます。会話はコンテキストウィンドウの45%を超えると自動的に圧縮されます。以降のすべてのターンがプレフィックス全体を再送するためです。Escで応答を中断しても圧縮は起こらず、後ろに予約されたメッセージも取り消されます。

### ローカル開発

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run validate
npm run verify:bridge
npm run pack
npm run companion:dir
npm run release:windows
```

ローカルのStream Deck開発環境では、次のコマンドでプラグインフォルダーをリンクします。

```powershell
npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin
```

ビルド成功後に`npm run preview`を実行すると、実際のアカウントデータを使用したSVGプレビューが`dist/previews`に出力されます。

`npm run release:windows`は完全な検証パイプラインを実行し、`.streamDeckPlugin`インストーラー、韓国語のインストールガイド、ランチャー、SHA-256チェックサムを含むバージョン付きWindowsリカバリーZIPを作成します。

### プライバシーとローカルデータ

- プラグインはClaudeの認証情報を読み取りません。
- プロンプトとClaudeの応答はブリッジに保存されません。
- 使用量とコンテキストのキャッシュは`%LOCALAPPDATA%\ClaudeUsageDeck`配下にローカル保存されます。
- プロジェクトフォルダーとキーの設定は、ローカルのStream Deckプロファイル内に保持されます。

[言語選択に戻る](#claude-for-stream-deck)
