# 인수인계 — Companion 대화 UI 재작성 + 응답 지연 해결 + 터미널/아이콘 개선

> 작성일: 2026-07-23T12:47:00+09:00
> 브랜치: main (origin/main과 동기화됨)
> 마지막 commit: 0959965

## Context

Stream Deck "Code Start"로 여는 Claude Deck Companion(Electron 앱)의 대화 경험을
전면 개선했다. 시작점은 "Console이 비어 있고 응답이 안 보인다"였으나, 계측·재현 과정에서
근본 원인이 **하나의 장수 stream-json 세션 구조에서 두 번째 메시지부터 ~120초 지연**임을
발견하고 구조를 재작성했다. 이후 사용자 요청으로 UI(대화 렌더링, 상태, CTX, 모델 선택,
기록 페이징, 터미널 복사, 아이콘)를 반복 개선했다. 범위: `companion/**` + 빌드 스크립트.
제약: statusLine(OMC) 슬롯 미변경, 신규 프로젝트에 --resume 미부착.

## 완료된 변경

- Commit: `0959965` — feat: Companion 대화 UI 재작성, 응답 지연 해결, 터미널/아이콘 개선
- 변경 통계: 37 files, +3294 / -386 (origin/main push 완료)
- 신규(11 소스 + 2 자산): `companion/main/{context-snapshot,pty-types,transcript-history}.ts`,
  `companion/renderer/transcript.ts`, `companion/shared/{build-version,diag,markdown,model-name}.ts`,
  각 테스트, `companion/assets/{icon.png,icon.ico}`
- 핵심 파일 맵:
  - `companion/main/claude-session.ts` — 메시지당 `claude --print --resume` 실행 매니저(재작성).
    end_turn 시 busy 해제, finaliseGraceMs 후 트리 kill(`taskkill /T /F`), 슈퍼시드 run 이벤트
    게이팅(`activeRun===run`), 잘못된 종료 에러 가드
  - `companion/shared/claude-stream.ts` — 구조화 `ClaudeEvent[]`(text/phase/context/error),
    계열 기반 컨텍스트 창(opus/sonnet=1M, haiku=200k), session_id 캡처, init은 ready phase 미방출
  - `companion/renderer/index.ts` — DOM 트랜스크립트, 상태 스트립, CTX 그라데이션 미터,
    모델·effort 선택, Clear, 기록 스크롤 페이징, 터미널 드래그 복사+토스트
  - `companion/renderer/transcript.ts` + `shared/markdown.ts` — textContent 전용 마크다운(XSS 안전)
  - `companion/main/transcript-history.ts` — .jsonl 스트리밍 파싱(텍스트만), 인덱스 페이징
  - `companion/main/context-snapshot.ts` — Stream Deck 키용 model/context 스냅샷 기록
  - `companion/main/terminal-session.ts` — PowerShell 상대 경로 프롬프트(CLAUDE_TERMINAL_ROOT env)
  - `companion/main/{window,paths}.ts` — 창 전면화, 폴더 최신 세션 자동 resume
  - 빌드: `scripts/build-companion.mjs`(버전 define + assets 복사), `electron-builder.yml`(win.icon)

## 검증 결과 (4-Agent)

- gap-detector: **ACCEPT** — 10개 기능 전부 구현·연결·상호일관. 스냅샷↔parseSnapshot 계약 일치
- code-reviewer: **ACCEPT** — CRITICAL/HIGH 0. MEDIUM 2건(지적 후 수정)
- security-reviewer: **ACCEPT / SAFE** — CRITICAL/HIGH 0. argv-array spawn, textContent, env-passed prompt
- critic: **ACCEPT** — 지적 MEDIUM(tree-kill, ready flicker, 모델 파서 divergence, 이벤트 bleed) 전부 반영

지적 반영: M1(에러 가드) M2(history try/catch) M3(ready flicker 제거) M4(이벤트 게이팅)
M5(tree-kill) M6(모델 파서 통합) + dead code 제거 + 보안 LOW(sessionId 허용목록, history clamp, CSP).
최종: typecheck PASS · test **212** · companion **112** · validate PASS · verify:bridge PASS.

## 후속 수정 (커밋 0959965 이후)

- **터미널 복사 버그**: 드래그 복사가 동작하지 않던 문제. 근본 원인은 렌더러의
  `navigator.clipboard.writeText`가 `NotAllowedError: Document is not focused`로 거부되는 것.
  → main 프로세스 clipboard로 라우팅하는 `clipboardWriteText` IPC 추가(이미지 복사와 동일 패턴).
  실측: 드래그 34자 선택 → OS 클립보드 기록 확인 → 토스트 표시.

## DEFERRED (의도적 미해결)

- 없음(4-Agent 지적 전부 반영). CSP는 xterm 호환 위해 style-src에 'unsafe-inline' 유지
  (script-src 'self'로 실제 XSS 벡터는 차단) — 의도된 절충.

## 잔존 위험 / 사용자 확인 필요

- **앱 아이콘은 재현본**: 채팅 첨부 이미지의 원본 바이트를 파일로 읽을 수 없어 SVG로 재현.
  픽셀 정확본이 필요하면 사용자가 PNG(≥256²)를 주면 `companion/assets/icon.png`로 교체 후 재빌드.
- **창 z-order / 아이콘 표시**: 실제 데스크톱 동작이라 자동 테스트 불가. dev 실행에서 크래시 없음만 확인.
- **패키지 NSIS 설치본**: `companion:package`는 node-pty native rebuild에 VS C++ workload 필요.
  현재 검증은 `companion:dir`(win-unpacked) 경로. 릴리스 설치본은 별도 빌드 필요.
- **빌드 시 Companion 종료 필수**: 실행 중이면 win-unpacked 파일 잠금으로 EPERM 실패(이전 바이너리 잔존).

## 다음 컨텍스트 시작 가이드

`docs/task/T20260723/HANDOFF-1247.md` 를 먼저 읽고 이어서 진행해줘.

(필요시) 다음 작업 후보:
1. 아이콘 픽셀 정확본 교체(사용자 PNG 제공 시).
2. 대화 기록 렌더링에 도구 사용 카드/thinking 표시 확장(현재 텍스트만).
3. NSIS 설치본 릴리스 파이프라인(node-pty rebuild 환경) 정비.
