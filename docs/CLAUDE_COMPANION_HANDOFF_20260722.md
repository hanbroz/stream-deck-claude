# Claude Companion 인수인계 문서

작성일: 2026-07-22 (KST)
대상: 다음 Claude Code 세션에서 Companion의 Claude 입력/출력 연결 문제를 재현하고 수정
현재 저장소: D:\020_PROJECT\20260716_STREAMDECK\_FIRST\claude-usage-streamdeck

## 1. 인수인계 요약

현재 사용자가 보고한 핵심 증상은 다음과 같습니다.

- Code Start로 Companion은 열리지만 Claude Console이 비어 있다.
- 오른쪽 아래 입력창에 메시지를 입력하고 전송해도 출력 창에 응답이 나타나지 않는다.
- 과거에는 No conversation found with session ID와 --print/--output-format=stream-json requires --verbose 오류가 번갈아 나타났다.
- 최근에는 세션 종료 또는 저장된 세션을 사용할 수 없다는 토스트가 표시되지만, 새 세션이 정상적으로 응답하는지 확인되지 않았다.

이 문서는 “소스가 수정되었는가”와 “사용자가 Code Start로 실제 최신 실행 파일을 실행했는가”를 분리하여 다음 세션이 바로 진단할 수 있도록 만든다. 현재 문제는 해결 완료로 간주하지 않는다.

## 2. 이미 구현된 제품 범위

다음 기능은 저장소에 구현되어 있다.

- Stream Deck Code Start가 프로젝트 폴더와 런타임 메타데이터를 Companion으로 전달한다.
- Companion이 프로젝트 파일/폴더 탐색기, 파일/폴더 생성, 더블 클릭 열기, 현재 폴더 열기, 프로젝트 터미널 열기를 제공한다.
- 폴더는 VS Code 스타일의 펼침/접힘 화살표로 표시한다.
- 파일은 Material Icon Theme 자산을 우선 사용하고 기본 아이콘으로 폴백한다.
- 탐색기, 콘솔/터미널, 콘솔/채팅 영역의 Split handle은 드래그 및 키보드로 조절되며 크기를 로컬에 저장한다.
- Claude Console은 일반 터미널 echo가 아닌 Claude의 구조화된 대화 스트림만 표시하도록 설계되어 있다.
- 오른쪽 아래 composer에서 한글 텍스트, Enter 전송, Shift+Enter 줄바꿈, 클립보드 이미지 첨부, 텍스트 복사를 지원한다.
- Code Start 버튼/상태 카드에는 긴 context 설명 없이 모델명만 표시한다.
- 종료 후 저장된 세션을 resume하려고 시도하되, 실제 대화가 없는 신규 프로젝트에서는 경고를 표시하지 않도록 조정했다.
- OMC가 사용하는 statusLine 슬롯을 덮어쓰지 않도록 bridge 설치 경로를 보존한다.

## 3. 현재 코드 경로

Claude 실행 인자는 companion/shared/claude-command.ts의 createClaudeCommandArgs에서 만든다.

~~~
claude --dangerously-skip-permissions --print --input-format stream-json
  --output-format stream-json --include-partial-messages --verbose
~~~

resume 모드에서는 위 인자 뒤에 --resume <sessionId>가 추가된다. Claude 명령 경로는 companion/main/main.ts에서 런타임 환경값을 읽어 ClaudePtyManager에 전달한다. 기본값은 claude이다.

현재 입력/출력 데이터 흐름은 다음과 같다.

~~~
textarea/전송 버튼
  -> renderer submitPrompt()
  -> sendIntent()
  -> preload api.claude.write()
  -> ipcRenderer.invoke(COMPANION_IPC.claudeWrite, ...)
  -> ipcMain.handle(COMPANION_IPC.claudeWrite, ...)
  -> ClaudePtyManager.write()
  -> encodeClaudeUserMessage()로 stream-json stdin 기록
  -> Claude stdout
  -> ClaudeStreamParser.push()
  -> ClaudePtyManager data 이벤트
  -> webContents.send(COMPANION_IPC.claudeData, ...)
  -> preload onData()
  -> renderer consoleTerminal.write()
~~~

관련 파일은 다음과 같다.

- companion/renderer/index.ts: 전송, resume 재시도 큐, Claude data/exit 구독
- companion/preload/index.ts: renderer와 main 사이의 typed API
- companion/main/ipc.ts: claudeStart, claudeWrite, claudeData, claudeExit IPC 등록
- companion/main/claude-session.ts: Claude 프로세스 spawn, stdin write, stdout/stderr/exit 처리
- companion/shared/claude-command.ts: CLI 인자와 IPC 채널
- companion/shared/claude-stream.ts: stream-json user/assistant 이벤트 파싱

## 4. 마지막 커밋과 변경 사항

현재 HEAD는 다음과 같다.

~~~
ad852b7 Keep Companion prompt sends observable and recoverable
~~~

마지막 커밋에서 전송 문제를 관찰 가능하게 하기 위해 다음을 바꿨다.

- claudeWrite IPC를 fire-and-forget ipcMain.on에서 ipcMain.handle/ipcRenderer.invoke로 변경했다.
- 전송 버튼을 추가하고 Enter 전송 실패를 catch하도록 했다.
- resume 세션이 아직 준비되지 않은 경우 전송 intent를 큐에 저장하고 신규 세션 시작 후 재전송하도록 했다.
- Claude stdin 오류를 [Claude Code error] 형태로 Console에 전달한다.
- IPC 회귀 테스트를 보강했다.

이 변경은 로컬과 origin/main에 모두 push되어 있다. 다만 사용자가 실행한 설치본/링크된 플러그인이 이 HEAD를 실제로 사용했는지는 아직 확인되지 않았다.

## 5. 검증된 사실

다음 검증은 이 세션에서 통과했다.

~~~
npm run typecheck                 PASS
npm test -- --reporter=dot       PASS (28 files, 144 tests)
npm run companion:test -- --reporter=dot  PASS (14 files, 44 tests)
npm run validate                  PASS
npm run verify:bridge             PASS
npm run companion:dir             PASS
~~~

앱과 동일한 구조화 인자로 로컬 Claude CLI를 직접 실행한 probe도 성공했다. C:\Users\이도한\.local\bin\claude.exe에서 stream-json 응답의 O/OK가 반환되었다. 따라서 현재 증상만으로 Claude CLI 인증 또는 Claude 자체의 고장이라고 단정하면 안 된다.

패키징은 node-pty native rebuild 단계에서 Visual Studio C++ workload가 없어 npm run companion:package가 실패했다. 그러나 기존 Electron용 native 모듈을 사용하여 다음 단계로 NSIS 설치 파일은 생성했다.

~~~
npm run companion:build
npm run pack
npm exec electron-builder -- --config companion/electron-builder.yml --win nsis --x64
~~~

생성된 설치 파일:

~~~
dist\companion\Claude Deck Companion Setup 0.6.1.exe
~~~

설치된 실행 파일:

~~~
C:\Users\이도한\AppData\Local\Programs\Claude Deck Companion\Claude Deck Companion.exe
~~~

## 6. 아직 확인되지 않은 경계

현재 가장 중요한 미확인 지점은 “새 코드가 실제 Code Start 런타임 경로에서 실행되는가”이다.

- 저장소 HEAD와 origin/main: 확인됨 (ad852b7)
- 설치 파일 생성: 확인됨
- 설치본 파일 존재: 확인됨
- 사용자가 지금 누른 Code Start가 설치본/ dist/companion/win-unpacked 중 어느 것을 실행했는지: 미확인
- 실제 Companion 프로세스의 claude.exe 자식 프로세스 생성: 미확인
- 실제 stdout이 parser와 renderer까지 전달되는지: 미확인
- 사용자가 입력한 session ID가 Claude가 만든 대화 ID와 같은지: 미확인

따라서 다음 세션은 UI를 더 수정하기 전에 실행 파일 경로와 transport 각 경계를 증명해야 한다.

## 7. 다음 Claude Code 세션의 우선순위

### 7.1 실행 파일/플러그인 경로 확인

다음 명령으로 새 세션의 출발점을 고정한다.

~~~powershell
Set-Location 'D:\020_PROJECT\20260716_STREAMDECK\_FIRST\claude-usage-streamdeck'
git status --short
git rev-parse HEAD
Test-Path '.\dist\companion\win-unpacked\Claude Deck Companion.exe'
Test-Path 'C:\Users\이도한\AppData\Local\Programs\Claude Deck Companion\Claude Deck Companion.exe'
~~~

로컬 개발 확인은 다음 순서로 한다.

~~~powershell
npm run companion:dir
npm exec -- streamdeck restart com.hanbroz.claude-usage
~~~

그 후 기존 Companion 창을 닫고 Code Start를 한 번만 눌러야 한다. dist/companion/win-unpacked/Claude Deck Companion.exe가 있으면 plugin launcher가 설치본보다 그 파일을 우선 선택한다. 필요하면 CLAUDE_DECK_COMPANION_PATH를 명시하여 실행 파일을 고정한다.

### 7.2 런타임 메타데이터와 프로세스 확인

Code Start 직전에 다음 환경값과 인자를 기록한다. 비밀 토큰이나 대화 본문은 기록하지 않는다.

~~~
CLAUDE_STREAM_DECK_FOLDER
CLAUDE_STREAM_DECK_PROJECT_NAME
CLAUDE_STREAM_DECK_CLAUDE_PATH
CLAUDE_STREAM_DECK_RESUME_SESSION_ID
CLAUDE_DECK_COMPANION_PATH
runtime metadata의 folder/projectName/resumeSessionId
~~~

작동 중에는 claude.exe의 실제 command line, cwd, parent process를 확인하여 다음을 증명한다.

- cwd가 Code Start에서 선택한 프로젝트 root인지
- command가 의도한 claude.exe인지
- resumeSessionId가 없는 신규 세션에 --resume가 붙지 않는지
- resumeSessionId가 있을 때 그 ID가 실제 Claude 프로젝트의 대화 ID인지

### 7.3 transport 진단 로그 추가

문제가 재현되는 최신 실행 경로에 아래 7개 지점의 임시 구조화 로그를 추가한다. 메시지 본문과 이미지 데이터는 절대 로그에 남기지 말고 session ID, 길이, timestamp, stage만 남긴다.

1. renderer submitPrompt()가 호출되었는지
2. renderer sendIntent()가 어떤 sessionId를 사용했는지
3. preload api.claude.write()가 invoke를 완료했는지/예외인지
4. main ipcMain.handle(claudeWrite)가 호출되었는지와 payload 길이
5. ClaudePtyManager.write()가 stdin에 기록되었는지
6. child stdout에 data가 왔는지, parser가 비어 있지 않은 conversation을 반환했는지
7. main claudeData send와 renderer onData/consoleTerminal.write가 실행되었는지

각 단계의 로그가 끊기는 지점이 실제 원인이다. 특히 3~5가 보이지 않으면 stale preload/main 또는 잘못된 실행 파일이고, 5 이후만 보이지 않으면 Claude CLI 인자/cwd/session 문제이며, 6 이후만 보이지 않으면 parser가 Claude 응답 형식을 놓치고 있는 것이다.

### 7.4 CLI probe 비교

Companion이 실제 사용하는 claudePath, cwd, args를 로그에서 복사하여 Electron 밖에서 같은 명령을 실행한다. probe가 성공하고 Companion만 실패하면 renderer/IPC 문제로 범위를 좁힌다. probe도 실패하면 Claude 경로, 환경, 인증, resume ID를 먼저 고친다.

과거 확인된 probe는 C:\Users\이도한\.local\bin\claude.exe에서 --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose 조합으로 성공했다.

## 8. 우선 가설

가능성이 높은 순서다.

1. Code Start가 최신 dist 또는 설치본이 아닌 이전 Companion binary를 실행한다.
2. IPC sender는 새 handler를 호출하지만 renderer가 다른 창/세션을 구독한다.
3. 새 세션과 저장된 resume session ID가 섞여 --resume가 실패한다.
4. Claude stdout은 도착하지만 ClaudeStreamParser가 실제 이벤트를 conversation으로 변환하지 못한다.
5. Electron에서 찾은 claude.exe와 PowerShell probe가 다른 환경/PATH를 사용한다.
6. 프로세스가 stderr/exit로 종료되었지만 종료 이유가 화면에 표시되지 않는다.

## 9. 변경 시 지켜야 할 제약

- statusLine 슬롯을 OMC 값으로 덮어쓰지 않는다.
- git reset --hard, 광범위한 삭제, C:\Users\이도한\.claude 삭제를 하지 않는다.
- 관계없는 Claude/Node 프로세스를 종료하지 않는다.
- 사용자 입력 본문, 클립보드 이미지, 인증 토큰을 진단 로그에 남기지 않는다.
- UI를 먼저 재설계하지 말고 실제 Code Start -> process -> stdout -> renderer data 경계를 먼저 증명한다.
- npm run companion:package의 native rebuild를 다시 시도할 때는 Visual Studio C++ workload 필요성을 문서화하고, 개발 중에는 npm run companion:dir 경로를 우선 사용한다.

## 10. 새 Claude Code 세션 시작 방법

PowerShell에서 새 Claude Code 세션을 연다.

~~~powershell
Set-Location 'D:\020_PROJECT\20260716_STREAMDECK\_FIRST\claude-usage-streamdeck'
claude --dangerously-skip-permissions
~~~

새 세션이 시작되면 아래 요청을 그대로 붙여 넣는다.

~~~
먼저 docs/CLAUDE_COMPANION_HANDOFF_20260722.md를 끝까지 읽고, 현재 저장소의 git 상태와 HEAD를 확인하세요.

사용자 증상은 “Code Start로 Companion은 열리지만 Claude Console이 비어 있고, 오른쪽 아래 입력창에서 전송해도 응답이 표시되지 않는다”입니다. 이 문제를 추측으로 고치지 말고, 인수인계 문서의 7.1~7.4 순서대로 실제 실행 파일 경로, runtime metadata, claude.exe 프로세스, renderer→preload→IPC→Claude stdin→stdout parser→renderer data 경계를 계측하여 어느 단계에서 끊기는지 재현하세요.

먼저 기존 테스트를 실행하고, 필요한 경우 메시지 본문/이미지를 기록하지 않는 stage/sessionId/length 기반 임시 로그와 회귀 테스트를 추가하세요. 신규 프로젝트에는 --resume를 붙이지 말고, 유효한 저장 세션이 있을 때만 resume 하세요. OMC statusLine 설정은 변경하지 마세요.

수정 후에는 typecheck, 전체 테스트, companion 테스트, validate, verify:bridge를 실행하고, 로컬 실행 경로와 설치/패키지 경로를 구분해 결과를 보고하세요. 해결되지 않으면 “어느 경계까지 확인되었고 다음 로그가 무엇인지”를 명확히 남기세요.
~~~

새 세션에서 기존 대화를 꼭 복원해야 하는 경우에만 실제 Claude session ID를 알고 있을 때 /resume <session-id>를 사용한다. 현재 인수인계에는 유효한 대화 ID가 보장되어 있지 않으므로, 디버깅은 새 세션으로 시작하는 것이 안전하다.

## 11. 완료 기준

다음 항목이 모두 증명되어야 해결 완료로 보고한다.

- Code Start가 의도한 최신 Companion 실행 파일을 실행한다.
- Companion cwd와 프로젝트 root가 일치한다.
- 신규 프로젝트는 경고 없이 새 Claude 세션이 시작된다.
- 입력 전송 시 claudeWrite handler와 stdin write가 실제로 호출된다.
- Claude의 유효한 stdout 이벤트가 parser를 통과해 Claude Console에 표시된다.
- resume ID가 있을 때만 기존 대화가 복원되고, 없는 경우 신규 세션이 정상 동작한다.
- Korean text와 clipboard image 입력이 기존 UI 계약을 유지한다.
- 기존 typecheck/test/validate/bridge 검증이 계속 통과한다.

현재 상태: 소스 수정과 테스트는 ad852b7까지 push됨. 설치 파일은 생성됨. 사용자가 누른 Code Start의 실제 live transport는 아직 미확인.

