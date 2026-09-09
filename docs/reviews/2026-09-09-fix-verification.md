# 주요 결함 수정 및 Red Team 재검증 — 2026-09-09

[전체 소스 검토](2026-09-09-source-red-team-review.md)에서 확인한 MEDIUM 결함 F1–F4를 수정했습니다. 버전은 0.18.1을 유지합니다.

## 수정 결과

| 항목 | 변경 및 검증 |
| --- | --- |
| F1 이미지 전송 거절 시 작성 내용 유실 | 이미지 개수·개별 크기·합계 크기·형식 검증을 main과 composer가 공유합니다. 잘못된 첨부는 작성 상태를 비우기 전에 차단하고 오류를 표시합니다. 초안·이미지·붙여넣기 유지, 정상 한도 전송, IPC 직접 호출의 방어를 검사했습니다. |
| F2 세미콜론 포함 폴더의 터미널 실행 오류 | Windows Terminal에 전달하는 폴더 인수의 세미콜론을 이스케이프합니다. 실제 작업 디렉터리는 원래 경로를 사용합니다. 일반 열기와 재로그인 양쪽 인수를 검사했습니다. |
| F3 드롭 파일의 일부 실패 누락 | 파일 경로 조회 실패를 복사 결과의 실패 목록에 합산합니다. 탐색기 새로고침이 실패해도 복사 결과와 실패 개수를 표시합니다. 혼합 성공·실패와 전체 경로 조회 실패를 검사했습니다. |
| F4 오래된 사용량이 최신 기록을 덮어씀 | 파일 잠금 안에서 캡처 시각을 비교하여 오래된 기록을 거부합니다. 같은 시각의 부분 병합과 더 최신인 낮은 사용량은 허용합니다. 비동기 완료 순서를 역전시킨 회귀 테스트를 포함합니다. |

F1의 이번 수정 범위는 첨부 검증으로 발생하는 전송 거절입니다. 모든 종류의 비동기 전송 오류에 대한 초안 복원 기능을 추가한 것은 아닙니다.

## 변경 파일

- 공통 이미지 검증: `companion/shared/image-attachments.ts` (신규), `companion/shared/composer.ts`, `companion/main/ipc.ts`
- 전송·드롭 표시: `companion/renderer/index.ts`
- 터미널 인수: `companion/main/windows-terminal.ts`
- 사용량 기록: `companion/main/usage-mirror.ts`
- 회귀 테스트: `companion/tests/composer.test.ts`, `ipc.test.ts`, `windows-terminal.test.ts`, `usage-mirror.test.ts`, `renderer-drop.test.ts` (신규), `renderer-submit.test.ts` (신규)

기존 이미지 검증을 공통 모듈로 옮겨 중복 정책을 방지했습니다. 새 의존성은 추가하지 않았습니다.

## 검증 증거

- 수정 전에 추가한 회귀 테스트가 실패하는 것을 확인했습니다: 이미지·드롭 6건, 터미널 2건, 사용량 순서 3건.
- 수정 후 `npm test`: **53개 파일, 474개 테스트 통과**.
- `npm run typecheck`: 통과.
- `npm run companion:build`: 통과. 빌드 표시 `ver. 2026.09.09.13.08`.
- `npm run build`: 플러그인·브리지·도구 빌드 통과.
- `npm run verify:bridge`: 통과.
- `npm run validate`: Stream Deck 매니페스트 검증 통과.
- `npm run verify:version`: 0.18.1 일치 확인.
- `git diff --check`: 통과.

renderer 회귀 테스트는 실제 함수 본문을 TypeScript AST로 추출하여 실행하고 UI·IPC 경계를 모의 처리했습니다. 실제 Electron GUI 조작 검증은 수행하지 않았습니다. 터미널 검증도 실행 인수 테스트이며 실제 Windows Terminal 창을 열지는 않았습니다.

## 독립 Red Team

- 보안 교차 검증 에이전트: F1·F3 수정에 **APPROVE**. 입력 검증, 초안 보존, 부분 실패 집계에서 추가 HIGH/MEDIUM 결함을 확인하지 못했습니다.
- 설계 검증 에이전트: F2·F4 수정에 **CLEAR**. 인수와 작업 디렉터리 구분, 잠금 내부 시각 비교, 같은 시각 병합, 최신 낮은 사용량 허용을 확인했습니다.

제품 구현 담당과 독립된 두 에이전트가 수정 내용을 검토했고, 총괄이 전체 테스트 및 빌드 결과를 확인했습니다.

## 남은 범위

최초 보고서의 LOW/WATCH 항목과 개발 의존성 감사 결과는 이번 네 가지 기능 수정에 포함하지 않았습니다. 로컬 소스와 빌드 산출물 검증을 완료했으며, 설치된 앱 업데이트·재시작, 실제 Claude 호출, 배포는 수행하지 않았습니다. 전체 제품의 무결함을 보증하는 판정은 아닙니다.
