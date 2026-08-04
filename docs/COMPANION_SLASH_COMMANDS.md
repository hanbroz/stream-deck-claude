# Companion 슬래시 명령 처리

Companion 컴포저에 `/`로 시작하는 입력이 들어왔을 때 무엇이 어떻게 실행되는지, 그리고 **왜 그렇게 나뉘는지**를 적는다. 분류를 바꿀 때는 이 문서와 `companion/main/slash-commands.ts`, `companion/shared/slash-commands.ts`를 함께 고친다.

## 전제: 이 앱은 매 메시지마다 새 프로세스를 띄운다

`companion/main/claude-session.ts`의 `write()`는 메시지 하나당 `claude --print`를 **새로 spawn**한다. 오래 사는 Claude 프로세스가 없다. 이 사실이 아래 분류 대부분의 근거다.

- 플러그인·스킬은 매번 디스크에서 새로 읽힌다 → Claude 쪽에 "다시 로드"할 대상이 없다.
- 대화형 TUI가 존재하지 않는다 → TUI를 여는 명령은 print 모드에 도달하지 못한다.
- 터미널에서 새로 띄운 `claude`는 **다른 대화**다 → 대화에 종속된 명령을 그쪽으로 넘기면 엉뚱한 대상에 적용된다.

## 다섯 갈래

| 갈래 | 명령 | 처리 |
|---|---|---|
| Companion 자체 | `clear` `reload-skills` `reload-plugins` | 앱이 직접 처리. 프로세스·과금 없음 |
| print 모드 | `compact` `usage` `cost` `context` `model` `init` `review` `security-review` | 평소 메시지처럼 `claude --print`로 전송 |
| CLI 브리지 | `plugin` `mcp` | `claude <name> …`을 execFile로 실행하고 출력을 표시 |
| 터미널 핸드오프 | 19개 (`config` `hooks` `permissions` …) | TERMINAL 탭에서 `claude /<name>` 실행 |
| 거부 | 8개 (`export` `rewind` `copy` `todos` `add-dir` `ide` `resume` `vim`) | 이유를 밝히고 실행하지 않음 |

### Companion 자체

`/clear`는 새 대화를 시작한다(예약 큐도 함께 비운다). `/reload-skills`·`/reload-plugins`는 **앱의 "/" 메뉴 목록만** 즉시 다시 읽는다 — 그 목록은 평소 30초 스로틀로 갱신되므로, 방금 설치한 플러그인이 메뉴에 안 뜨는 구간이 생긴다. Claude 쪽은 위 전제대로 재로드가 필요 없다.

### print 모드

CLI 바이너리의 명령 정의에 `supportsNonInteractive: true`가 붙은 것들. 판정은 추측이 아니라 바이너리에서 확인하고, 실제로 실행해 검증한다.

`/compact`은 특수하다. 실측(앱과 동일한 `--input-format stream-json` 경로) 결과:

- 성공하지만 **응답 텍스트가 비어 있다**
- 요약에 ~59초, 여기에 SessionStart 훅 오버헤드(측정값 22~131초)가 더해진다

그래서 렌더러가 전송 즉시 안내 턴을 세우고 완료 시 바꿔 쓴다. 이 안내 턴은 **압축이 실제로 일어나지 않은 모든 경로에서 반드시 제거**해야 한다(`discardCompactingPlaceholder`). 남겨두면 다음 `waiting`이 그것을 "압축했습니다"로 바꿔 **거짓 성공**을 보고한다. 해당 경로: 스트림 error, 로그인 만료, 사용자 중단, 세션 kill, 전송 실패, 다음 전송의 재할당.

`ready`가 아니라 `waiting`에서만 해소하는 것도 같은 이유다. `ready`는 `clear()`와 `interrupt()`가 합성해서 보내는 값이라 압축이 일어나지 않았다.

### CLI 브리지

`/plugin`·`/mcp`는 TUI 슬래시 명령이지만 **비대화형 CLI 서브커맨드로도 존재**한다. `claude plugin marketplace remove <name>` 같은 것.

- `execFile`을 쓴다. 인자는 배열로 전달되어 **셸을 거치지 않는다**. `exec`나 `shell: true`로 바꾸면 컴포저 입력이 셸 주입이 된다 — 테스트가 이를 고정한다.
- stdin을 즉시 닫는다. 확인을 묻는 서브커맨드가 60초 타임아웃까지 매달리지 않게.
- 실패는 던지지 않고 `{ ok: false, failure, output }`으로 돌려준다. `failure`가 필요한 이유: 타임아웃과 1MB 절단은 **부분 출력**을 남기므로, 그것이 완전한 답으로 읽히면 안 된다.

### 터미널 핸드오프

TUI 전용이지만 **결과가 대화와 무관한** 19개. TERMINAL 탭을 열고 `claude /<name>`을 보낸다. 슬래시 명령을 초기 프롬프트로 넘기면 모델 호출 전에 로컬에서 해석되므로 즉시 열리고 과금이 없다.

셸에 쓰는 문자열은 `claude /` + **허용목록의 리터럴 이름**뿐이다. 사용자·모델이 입력한 텍스트는 한 글자도 셸에 닿지 않는다.

새 셸이면 Enter까지 보내고, 이미 쓰던 터미널이면 줄만 넣어둔다 — 거기서 Claude TUI가 돌고 있으면 Enter가 그 줄을 모델에게 메시지로 보내버리기 때문이다. 또한 `terminal.write`는 `ipcRenderer.send`라 성공 확인이 불가능하므로, 안내 문구가 "실행했다"고 단언하지 않는다.

### 거부

터미널로 넘기면 **새 대화**에 적용되어 무의미하거나 오해를 낳는 8개. `/export`는 빈 대화를 내보내고, `/rewind`는 없는 체크포인트를 찾고, `/copy`는 아무것도 복사하지 않는다. 되는 것처럼 보이면서 틀리는 것보다 이유를 밝히고 거부하는 편이 낫다.

`--resume`으로 Companion의 세션에 붙이면 이 8개도 맞출 수 있지만, Companion도 매 메시지 같은 세션에 `--print --resume`으로 붙기 때문에 두 프로세스가 한 대화를 동시에 쓰게 된다. 트랜스크립트가 갈라질 수 있어 채택하지 않았다.

## 보안 경계: 모델이 쓴 텍스트는 로컬 명령이 될 수 없다

`question` 카드의 옵션 라벨은 **모델이 자유롭게 쓰는 문자열**이고, 클릭하면 그대로 `sendIntent`로 들어간다. 로컬 명령 분기는 CLI 서브커맨드를 실행하고 살아있는 셸에 쓰므로, 그 텍스트가 분기에 도달하면 **클릭 한 번으로 `/mcp add … -- cmd /c <payload>`가 실행**된다. MCP 서버는 `~/.claude.json`에 영속되어 이후 모든 세션에서 기동한다.

그래서 `SubmitIntent.origin`으로 출처를 태깅하고, `origin === "model"`이면 로컬 명령 분기 전체를 건너뛴다. 모델이 쓴 텍스트는 **답변으로만** 전송된다.

새 로컬 명령을 추가할 때 이 가드를 우회하지 않는지 확인할 것.

## 큐와의 상호작용

응답 생성 중에 보낸 메시지는 `pendingSendQueue`에 예약되고, 턴 경계(`waiting`/`ready`)마다 **하나씩** 풀린다. 그런데 로컬 명령 분기는 런을 시작하지 않으므로 phase 이벤트를 만들지 않는다.

따라서 **런 없이 return하는 모든 분기는 `flushNextPendingSend()`를 호출해야 한다.** 빠뜨리면 뒤에 예약된 메시지가 깨울 이벤트가 영영 오지 않아 무기한 방치되고, 나중에 보낸 메시지가 그 아래에 붙어 트랜스크립트 순서까지 어긋난다.
