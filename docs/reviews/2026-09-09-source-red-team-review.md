# 전체 소스 및 Red Team 검토 — 2026-09-09

> 후속 상태: 주요 결함 F1–F4는 수정하고 회귀 테스트 및 독립 Red Team 재검증을 완료했습니다. [수정 검증 보고서](2026-09-09-fix-verification.md)를 참조하세요. 아래 내용은 수정 전 검토 기록입니다.

## 대상과 검토 방식

- 저장소: `claude-usage-streamdeck`, 버전 `0.18.1`
- 기준 HEAD: `f1e287966133ef03ac413d871e63eb6d5251ac48`
- 시작 시 작업 트리: clean
- 전체 추적 파일 226개를 목록화. TypeScript 120개: 앱 코드 67개, 테스트 51개, 스크립트 1개, Vitest 설정 1개.
- 최근 변경분에 한정하지 않고 현재 소스 전체를 범위로 지정했다. 각 담당자가 목록·패턴 검색 후 실행 경로와 관련 테스트를 직접 읽었다. 모든 파일의 모든 줄을 동일 깊이로 수동 검토했다는 뜻은 아니다.
- 완료된 검토 레인 6개와 총괄 1개: 플러그인 리뷰, Companion main/preload 리뷰, renderer/shared 리뷰, 독립 Red Team 보안, 독립 Red Team 장애·설계, 의존성·공식 근거 조사. 최초 보안 에이전트는 장시간 결과 미회수로 중단했고, 별도의 독립 보안 에이전트가 핵심 경계를 교차검증해 최종 결과를 반환했다.
- 총괄은 테스트·빌드·네이티브 PTY 검사 및 중요 발견의 독립 재현과 오탐 제거를 수행했다.
- 개인 Windows 앱이라는 범위를 적용했다. 문서에 명시된 `--dangerously-skip-permissions` 자체를 새로운 결함으로 분류하지 않았다.
- 제품 소스 수정, 의존성 업데이트, 설치·배포·실제 Claude 호출은 수행하지 않았다. 빌드 생성물과 검토 문서·임시 검증 자료만 생성했다.

## 판정

**REQUEST CHANGES — 기본 검사는 통과하지만 아래 기능 결함과 검증 공백이 남아 있다.**

설계 검토 상태: **WATCH**. 일반 리뷰·독립 설계 리뷰·독립 보안 교차검증 결과를 모두 회수했다. 최종 주요 기능 결함은 **MEDIUM 4건**이며, 검토한 공격 경로에서 CRITICAL/HIGH 보안 취약점은 확정하지 못했다. 이는 제품 전체에 그러한 취약점이 없다는 보증은 아니다.

## 주요 발견

### F1. MEDIUM — 이미지 전송 거절 후 작성 내용이 복원되지 않음

- 위치: `companion/shared/composer.ts:170`, `companion/renderer/index.ts:2593`, `companion/renderer/index.ts:3042`, `companion/renderer/index.ts:3062`
- 조건: 이미지 11장 또는 합계 30 MB를 초과하는 이미지를 첨부하고 전송한다.
- 경로: `addImages`/`addComposerImages`는 한도 초과 첨부를 허용한다. `submitComposer`는 전송 의도를 반환하며 작성 상태를 먼저 초기화한다. renderer도 입력란과 미리보기를 지운다. 이후 main의 `optionalImageDataUrls`가 요청을 거절하지만 오류 처리에서 원래 작성 상태를 복원하지 않는다.
- 영향: 전송은 실패하고 사용자는 이미지를 다시 첨부해야 한다. 텍스트는 기록 등에서 회수할 여지가 있으므로 영구 데이터 삭제로 표현하지 않는다. 전송 전에 추가된 사용자 대화 항목도 남는다.
- 재현: 실제 composer와 IPC 함수를 mock manager로 연결했다. 결과는 `acceptedByComposer=11`, `imagesInClearedDraft=0`, `ipcRejected="imageDataUrls must contain at most 10 images"`, `claudeWrites=0`이다. 복원 부재는 renderer 오류 경로에서 확인했다. 실제 GUI 클릭 재현은 수행하지 않았다.
- 수정 방향: 작성 상태를 비우기 전에 main과 같은 한도를 검사하고 입력을 유지한다. 비동기 전송 실패 시에는 새로 입력 중인 내용을 덮어쓰지 않는 복원 또는 재시도 동작을 제공한다.
- 필요한 회귀 검증: 11번째 이미지, 합계 30 MB 초과, 전송 거절 후 첨부와 초안 유지.
- 확신: 높음.

### F2. MEDIUM — 세미콜론 포함 프로젝트 경로에서 Windows Terminal 인자 경계가 깨짐

- 위치: `companion/main/windows-terminal.ts:22`
- 조건: `D:\Projects\a;b`처럼 유효한 Windows 폴더명에 `;`가 포함된다.
- 경로: Companion의 터미널 열기와 재로그인 경로는 `wt.exe -d`에 폴더를 그대로 전달한다. Windows Terminal은 argv 내부의 세미콜론도 자체 명령 구분자로 해석한다.
- 영향: 프로젝트 터미널 또는 로그인 터미널을 잘못된 인자로 열거나 시작에 실패할 수 있다. 원격 코드 실행으로 검증한 것은 아니다.
- 근거: 실제 함수의 계획 결과는 `args=["-d","D:\\Projects\\a;b"]`다. 동일 저장소의 `src/services/terminal-launcher.ts:45`는 이미 `folder.replaceAll(";", "\\;")`를 적용한다.
- 외부 확인: [Microsoft 실제 argv 분리 구현](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/AppCommandlineArgs.cpp#L824-L933), [Microsoft 명령행 escaping 명세](https://github.com/microsoft/terminal/blob/main/doc/specs/%23607%20-%20Commandline%20Arguments%20for%20the%20Windows%20Terminal.md#commandline-escaping).
- 수정 방향: WT에 전달하는 `-d` 값에 동일 escape를 적용한다. 파일시스템 `cwd`는 원래 경로를 유지한다.
- 필요한 회귀 검증: 명령 없는 터미널 열기와 재로그인 두 경로에서 세미콜론·공백 포함 폴더 인자 확인.
- 검증 한계: 실제 WT 창을 띄우지는 않았다. 현재 로컬 코드와 공식 parser 계약으로 확인했다.
- 확신: 높음.

### F3. MEDIUM — 드롭한 일부 파일의 경로 읽기 실패가 성공 안내에서 누락됨

- 위치: `companion/renderer/index.ts:1721`, `companion/renderer/index.ts:1770`
- 조건: 일반 파일과 파일시스템 경로를 얻을 수 없는 가상 항목 등을 함께 드롭한다.
- 경로: `api.paths.filePath`가 실패하거나 빈 경로를 반환한 항목은 빈 문자열로 바뀌고 필터에서 사라진다. 남은 항목만 main으로 전달되므로 최종 `failed` 목록에는 경로 조회 실패가 포함되지 않는다.
- 영향: 일부 항목이 복사되지 않았는데도 성공 안내만 표시된다. `specs/explorer-drop-copy.md`의 부분 실패 개수 안내 계약과 다르다.
- 재현: 실제 renderer의 `copyDroppedFiles` 함수를 TypeScript AST로 추출해 변환하고 경로·복사·토스트만 mock 처리했다. 2개 중 1개 경로 조회를 실패시켜도 출력은 `'good.txt'를 복사했습니다.`뿐이다. 실제 파일 복사는 수행하지 않았다.
- 수정 방향: renderer 단계의 경로 실패도 집계해 최종 복사 결과의 실패 목록에 합산한다.
- 필요한 회귀 검증: 두 항목 중 한 항목의 경로 조회 실패 시 성공 1·실패 1 안내. 전체 경로 실패 시 기존 실패 안내 유지.
- 확신: 높음.

### F4. MEDIUM / 설계 WATCH — 오래된 usage snapshot이 최신 기록을 덮어쓸 수 있음

- 위치: `companion/main/usage-mirror.ts:74`, `companion/main/main.ts:303`
- 조건: 여러 Companion 창 또는 비동기 기록이 경합해 오래전에 캡처한 이벤트가 최신 기록 이후 lock을 획득한다.
- 경로: `writeUsageRateLimits`는 파일 lock으로 쓰기를 직렬화하지만 `capturedAt`의 최신 여부는 비교하지 않는다. 호출부는 쓰기 Promise를 기다리지 않는다. 상호 배제와 시간순 정렬은 다른 조건이다.
- 영향: 최신 사용량·캡처 시각을 과거 값으로 되돌릴 수 있다.
- 재현 1: 임시 cache에 `capturedAt=2000, usage=80`을 기록한 뒤 `capturedAt=1000, usage=20`을 전달했다. 최종 파일은 `1000, 20`으로 바뀌었다.
- 재현 2: 명시적 timestamp 없이 실제 함수 두 개를 동시에 호출하고 첫 호출의 `mkdir`만 지연시켰다. 나중 호출의 `capturedAt=1788926281741, usage=80` 기록이 끝난 후 첫 호출을 재개하자 `capturedAt=1788926281707, usage=30`으로 역전됐다. 실제 앱의 fire-and-forget 호출 형태에서 발생 가능한 I/O 순서다. 이 재현은 같은 프로세스의 제어된 스케줄링이며 실사용 발생 빈도나 다중 프로세스 경합 빈도는 측정하지 않았다.
- 비교 근거: `src/io/usage-cache.ts:219`의 newer-only 경로와 `src/services/omc-stdin-sync.ts`는 lock 내부에서 캡처 시각을 비교한다.
- 수정 방향: lock 내부에서 더 오래된 입력의 기록을 거절한다. 계정 전환 시 낮은 사용량으로 바뀌는 정상 동작은 보존해야 한다. 사용률을 무조건 최댓값으로 합치는 수정은 적절하지 않다.
- 필요한 회귀 검증: 오래된 complete/partial snapshot, 역전된 lock 획득 순서, 새 계정으로 전환된 최신 snapshot 허용.
- 확신: 오래된 기록 수용과 역전된 비동기 쓰기 동작은 높음. 실제 사용 중 빈도는 미측정.

## 낮은 우선순위 및 검증 공백

| 항목 | 위치 | 판단·후속 검증 |
| --- | --- | --- |
| PTY 시작 크기 검증 일관성 | `companion/main/ipc.ts:196` | start는 number 타입만 확인하고 resize는 양의 정수를 확인한다. 정상 renderer는 xterm 크기를 전달하므로 실제 사용자 오류는 확인하지 못했다. 방어 강화 LOW로 분류한다. |
| 긴 붙여넣기의 제한 문구 포함 여부 | `companion/shared/composer.ts:44` | 201,234자 입력은 본문 200,000자에 잘림 안내가 붙어 200,015자가 된다. 실제 함수로 확인. 사소한 경계·명세 차이이며 큰 비용 결함으로 보지 않는다. |
| 삭제된 검색 결과의 안내 정책 | `companion/renderer/index.ts:1337` | 삭제·이동된 결과는 조용히 종료한다는 명세와 달리 토스트를 표시한다. LOW 명세 차이. |
| 동일 conversation의 동시 `--resume` | `companion/main/claude-session.ts:125` | background agent가 남은 run과 다음 run이 같은 transcript를 사용할 수 있으며, CLI의 동시 resume 허용 여부가 미검증이라고 코드에도 명시돼 있다. 실제 transcript 손상은 확인하지 않았다. WATCH 검증 공백이다. |
| CI의 Companion 빌드·패키징 공백 | `.github/workflows/ci.yml:31` | CI는 전체 테스트와 typecheck를 수행하지만 별도 Companion 번들·installer를 검증하지 않는다. 전체 `npm test`에 Companion 테스트가 포함되므로 동일 테스트를 다시 추가할 필요는 없다. `companion:build`와 적절한 packaging 검증 추가가 필요하다. |

## Red Team 보안 검토

독립 보안 에이전트가 아래 경계를 읽기 전용으로 교차검증했다. 확인한 비신뢰 모델 출력 경로에서 확정 XSS·셸 주입·경로 탈출은 발견하지 못했다.

| 방어 경계 | 근거 |
| --- | --- |
| Electron renderer 격리 | `companion/main/window.ts:55`의 context isolation·sandbox, Node integration 비활성화. `:76` 새 창·navigation 차단. |
| CSP와 출력 삽입 | `companion/renderer/index.html:11`의 제한된 CSP. `companion/renderer/transcript.ts:43` 등의 text node 삽입과 제한된 Markdown AST. |
| 파일 경계 | `companion/main/paths.ts:300`의 lexical/realpath 이중 검사. `:420` 프로젝트 루트 삭제 거절, `:600` 복사 대상 검사. |
| CLI 호출 | `companion/main/cli-command.ts:52`의 allowlist와 `execFile` argv 배열. |
| preload | `companion/preload/index.ts:118` 등의 고정 API와 IPC event 객체 비노출. |

환경 의존·미재현 후보는 확정 취약점에서 분리했다.

- **IPC sender 검사:** 일부 handler가 `_event`를 무시한다. 현재 renderer 진입 경로에서 이를 악용할 수 있는 공격 원천은 확인하지 못했다. 추가 방어 후보다.
- **OS 파일 연결:** `companion/main/paths.ts:432`는 실행 확장자 denylist다. `.py`처럼 목록 밖 확장자도 Windows의 파일 연결에 따라 실행될 수 있어, “트리 클릭은 절대 실행하지 않는다”는 주석은 구현보다 강하다. 실제 사용자 파일 연결과 실행 결과는 검사하지 않았다.
- **파일시스템 TOCTOU:** realpath 검사 이후 실제 작업까지의 사이에 다른 로컬 프로세스가 경로를 바꾸는 경쟁 조건은 이번에 재현하지 않았다. 모델 출력만으로 성립하는 경로 탈출로 단정하지 않는다.

보안 검토는 지정된 소스 경계의 정적 검증이다. 최초 보안 에이전트에서 회수하지 못한 결과는 통과 근거에 포함하지 않았다.

## 오탐·과장 제거

- 최초 renderer 보고의 “이미지 한도가 없어 대형 요청이 Claude에 전달된다”는 주장을 철회했다. main의 10장·30 MB 제한이 실제 요청을 차단한다. 최종 F1은 전송 실패 뒤 초안 복원 문제다.
- 잘림 안내 15자 초과는 주요 비용·보안 결함으로 집계하지 않았다.
- PTY 크기 입력의 비정상 숫자는 정상 UI 발생 경로가 확인되지 않아 실제 사용자 결함과 분리했다.
- 새 계정의 사용량이 더 낮아지는 것은 정상이다. F4는 사용률 감소 자체가 아니라 오래된 캡처 시각 수용 문제다.
- 전용 LSP 도구의 부재를 단독 승인 차단 사유로 삼지 않았다. 현재 전체 TypeScript 검사는 통과했다.

## 실행한 검증

| 검사 | 결과 |
| --- | --- |
| `npm test` | 51개 파일, 458개 테스트 PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run companion:build` | PASS |
| `npm run verify:bridge` | PASS — 임시 폴더에서 cache·hook 격리·forwarding 검사 |
| `npm run validate` | PASS |
| `npm run verify:version` | PASS — 0.18.1 |
| `git diff --check` | PASS |
| 런타임 HTML 인라인 스크립트 구문 검사 | 1개 PASS, 실행 없이 파싱 |
| Electron 네이티브 PTY smoke | Electron 43.1.1 / Node 24.18.0에서 PowerShell 출력 marker 확인, exit 0 |
| 독립 재현 probe | F1·F3·F4 및 F2의 생성 argv, 붙여넣기 경계 결과 확인 |
| 전체 `npm audit --json` | 영향을 받는 개발 의존성 패키지 10개: High 7 / Moderate 3 / Critical 0 |
| `npm audit --omit=dev --json` | 영향 패키지 0개 |

기존 테스트 전체 통과는 위 예외 경로에 결함이 없다는 증거가 아니다. 별도 lint 스크립트는 구성되어 있지 않다.

### 의존성 경고의 해석

대상 패키지는 `vitest`, `@vitest/mocker`, `@xmldom/xmldom`, `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `tar`, `undici`다. 관련 설치 노드 15개 모두 lockfile의 `dev:true`이고 의존 트리도 개발·테스트·다운로드·패키징 도구 경로다. 앱 취약점 10개를 확인했다는 뜻이 아니다.

- Vitest 4.1.10 / mocker 4.1.10: [upstream advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9). 해당 개발 서버 플러그인 노출 조건은 이 저장소의 Node 테스트 설정에서 확인되지 않았다.
- xmldom 0.8.13: [upstream advisory](https://github.com/xmldom/xmldom/security/advisories/GHSA-965w-775f-mr7g). 비신뢰 XML 입력을 받는 빌드 도구 경로에 대한 검토·업데이트 대상이다.
- brace-expansion 1.1.16 / 2.1.2 / 5.0.7: [upstream advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-rgw5-rvv9-x895).
- fast-uri 3.1.3: [upstream advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc).
- js-yaml 4.3.0: [upstream advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh).
- nanoid 3.3.16: [upstream release](https://github.com/ai/nanoid/releases/tag/3.3.18). 실제 PostCSS 호출은 `nanoid(6)`로 size=0 조건과 다르다.
- postcss 8.5.19: [upstream advisory](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp).
- tar 7.5.20: [upstream advisory](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m).
- undici 6.27.0 / 7.28.0: [upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-4cwx-7wf7-3272). 대표 High의 shared cache 조건은 앱에서 확인되지 않았다.

개발 의존성 업데이트는 별도 수정 작업으로 다뤄야 한다. production audit 0건으로 Electron 내장 Chromium/Node 또는 배포 파일 전체의 안전성을 보증하지 않는다.

## 증거와 한계

- [검증 결과 JSON](../../.omx/reviews/2026-09-09/validation.json)
- [재현 스크립트](../../.omx/reviews/2026-09-09/probes.cjs)
- [재현 결과 JSON](../../.omx/reviews/2026-09-09/probe-results.json)

재현 명령: 저장소 루트에서 `node .omx/reviews/2026-09-09/probes.cjs`. 실제 Claude·사용자 캐시를 사용하지 않으며 임시 폴더는 경로 확인 후 제거한다. `.omx` 자료는 로컬 ignore 대상이다.

실제 Stream Deck 장치·설치된 Companion GUI의 전 구간 조작, 실제 Claude 통신과 장시간 동시 resume, NSIS installer 생성·설치는 이번에 수행하지 않았다. 빌드 생성물의 갱신을 설치된 앱에 적용됐다고 주장하지 않는다. 생성 번들과 vendored SVG는 직접 작성 소스와 같은 깊이의 수동 검토 대상이 아니며, 생성 번들은 빌드 검사로 확인했다.
