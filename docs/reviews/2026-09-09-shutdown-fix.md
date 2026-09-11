# Companion 창 종료 오류 수정

## 원인과 수정

창을 닫은 뒤 ProjectTerminalManager의 지연 출력/종료 이벤트가 파괴된 BrowserWindow 또는 webContents에 접근했습니다. `before-quit`의 `killAll()`도 이 이벤트를 발생시킬 수 있습니다. 기존 검토와 테스트에는 이 종료 순서가 빠져 있었습니다.

`companion/main/ipc.ts`에서 Claude와 프로젝트 터미널의 출력·종료 네 경로에 공통 전송 가드를 적용했습니다. BrowserWindow를 먼저 확인하고, 살아 있는 창의 webContents만 읽은 뒤 webContents의 파괴 여부도 확인합니다. `closed` 시에는 해당 창에 전송하는 리스너 네 개만 해제하여 세션 정리와 다른 구독자는 유지합니다.

## 검증

- 새 `companion/tests/ipc-lifecycle.test.ts`의 초기 회귀 테스트 네 개 중 세 개가 수정 전 실패했습니다. 두 경우는 보고된 것과 같은 `TypeError: Object has been destroyed`, 한 경우는 종료 후 남은 리스너를 검출했습니다.
- 동기적인 PTY kill 이벤트 사례를 추가하여 회귀 테스트 총 다섯 개를 검사했습니다.
- 수정 후 전체 테스트: 54개 파일 / 479개 통과. 타입 검사 및 diff 공백 검사 통과.
- 실제 Electron의 숨김 BrowserWindow를 닫은 뒤 지연 출력을 주입하고 실제 node-pty 터미널을 종료했습니다. 실제 창 파괴, 지연 이벤트 처리, PTY 종료를 관찰했고 uncaught exception은 0개였습니다. 이 검증 도구는 처음에 `close()`가 즉시 파괴된다고 잘못 가정했으므로 `closed` 이벤트를 기다리도록 고친 뒤 실행했습니다.
- 독립 Red Team이 네 전송 경로의 가드와 리스너 정리 범위를 검토했고 차단 결함을 발견하지 못했습니다.
- Companion 빌드 표시: `ver. 2026.09.09.15.03`.
- 기존 Companion 프로세스가 모두 종료된 것을 확인한 후 `dist/companion/win-unpacked`를 다시 패키징했습니다. 이 경로가 오류 발생 당시 실행 중인 로컬 앱의 경로였습니다.
- 최종 패키지 main/preload/renderer 다섯 파일과 현재 빌드 파일이 일치했고, 패키지 Electron에서 PTY 출력 및 종료 검증도 통과했습니다.

이번 수정은 로컬 소스와 실행 파일에 반영했습니다. 제품 버전은 0.18.2를 유지하며 이미 게시된 GitHub 릴리즈 ZIP이나 설치된 별도 앱을 교체하지 않았습니다. 실제 Claude 호출 및 사용자의 프로젝트로 GUI 수동 검증은 수행하지 않았습니다.
