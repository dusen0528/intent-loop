# Intent Loop

한국어 · [English](README.en.md)

> 긴 코딩 작업을 위한 세션 제약 보존 하네스

사용자 제약을 대화 요약과 분리해 저장하고, 압축·재개 후 복원합니다. 새 사용자 메시지의 제약 검토를 제출하기 전에는 훅이 관찰하는 작업 도구 호출을 차단합니다.

## Background

모델이 개선되면 이전 세대의 한계를 보완하던 하네스도 재검토해야 합니다. 고정된 계획 단계, 도구 사용 순서, 반복 검증 지침은 새로운 모델의 판단을 불필요하게 제한할 수 있습니다. 모델에 더 많은 판단을 맡기는 구성에서는 이러한 장치를 줄이고, 남겨둘 기능과 유지보수 비용을 따져야 합니다.

Intent Loop는 이 구성을 전제로 합니다. 계획·구현·검증과 작업 반복은 기존 에이전트에 맡기고, 긴 작업에서 사용자 제약을 유지하는 부분에만 개입합니다.

턴이 길어지면 사용자 요청, 도구 출력, 중간 결과가 컨텍스트에 누적됩니다. 에이전트는 작업을 계속하기 위해 이를 압축합니다. Compactor는 일반적으로 다음 작업을 이어가는 데 필요한 목표와 진행 상태, 즉 **WHAT**을 보존하는 데 초점을 맞춥니다. 작업 방법을 제한하는 **HOW**는 요약에서 누락될 수 있습니다. [관련 연구](https://arxiv.org/html/2608.11242v1)

이 차이는 장기 실행에서 문제가 됩니다. 최근의 구현 상태는 남아 있는데, 초반에 명시한 파일 변경 제한이나 승인 조건은 더 이상 다음 모델 호출에 제공되지 않을 수 있습니다. 모델이 목표를 계속 수행하더라도 실행 방식은 사용자 요구에서 벗어날 수 있습니다.

## 설치

**Node.js 22+ · Python 3.10+ · Linux/macOS · 사용할 호스트의 CLI**

기본 설치는 **사용자 전역 플러그인**입니다. 어느 디렉터리에서든 한 번 설치하면 해당 사용자의 새 프로젝트/세션에서 로드됩니다. 상태는 매 작업 디렉터리의 `.intent-review/<세션 해시>.json`에 분리됩니다. 다른 컴퓨터나 사용자에게 자동 설치되는 것은 아닙니다.

### npm (권장)

```sh
# Codex 전역 플러그인
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@0.3.0 -- intent-loop init --host codex

# Claude Code 전역 플러그인
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@0.3.0 -- intent-loop init --host claude
```

`--scope user`가 기본입니다. 설치기는 플러그인 파일을 `~/.local/share/intent-loop/0.3.0/`에 보관한 다음 호스트의 공식 플러그인 CLI로 `intent-loop@intent-loop`를 설치합니다. npm 캐시를 지워도 실행 파일이 사라지지 않습니다. 별도 의존성이나 npm 자동 설치 스크립트는 없습니다.

Codex와 Claude는 각각 `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`과 공통 `hooks/hooks.json`, `skills/`를 사용합니다. 마켓플레이스는 각 호스트의 규격에 맞춰 별도 파일로 제공합니다.

Codex는 새 플러그인의 훅을 최초 한 번 `/hooks`에서 검토·신뢰해야 합니다. 이 신뢰는 플러그인에 기록되므로 프로젝트마다 반복할 필요가 없지만, 훅 정의가 바뀌면 다시 검토해야 합니다. 설치기는 신뢰 해시를 작성하거나 신뢰 검사를 우회하지 않습니다. 설치·업데이트 후에는 새 세션에서 사용하세요.

CLI를 찾을 수 없다는 오류가 나면 먼저 해당 호스트의 CLI 설치/PATH를 확인하세요. 호스트 명령이 실패하면 완료된 단계와 소스는 보존되며, 오류 해결 후 같은 명령으로 재시도할 수 있습니다.

### GitHub / Git clone

저장소 접근 권한이 있는 경우:

```sh
git clone https://github.com/dusen0528/intent-loop.git
node intent-loop/bin/intent-loop.mjs init --host codex
node intent-loop/bin/intent-loop.mjs init --host claude
```

호스트의 마켓플레이스 CLI로 직접 설치할 수도 있습니다.

```sh
codex plugin marketplace add ./intent-loop
codex plugin add intent-loop@intent-loop

claude plugin marketplace add ./intent-loop --scope user
claude plugin install intent-loop@intent-loop --scope user
```

### 업데이트

**Codex·Claude의 열린 세션을 모두 종료하고 외부 터미널에서 실행하세요.** 호스트가 업데이트 중 이전 캐시를 제거할 수 있어 실행 중인 세션의 훅이 깨질 수 있습니다. CLI는 `CODEX_THREAD_ID` 또는 `CLAUDECODE`가 있는 에이전트 내부의 업데이트를 거부합니다. 다른 프로세스의 활성 세션을 자동 탐지하지는 않습니다.

최신 npm 버전으로 전역 플러그인을 업데이트합니다. 해당 버전이 npm에 게시된 뒤 사용할 수 있습니다.

```sh
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@latest -- intent-loop update --host codex
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@latest -- intent-loop update --host claude
```

버전을 고정하려면 `@latest` 대신 `@0.3.0`을 사용합니다. Git clone 설치는 `git pull --ff-only` 후 `node bin/intent-loop.mjs update --host codex`를 실행합니다. Claude는 호스트 인자를 `claude`로 바꿉니다.

`update`는 실행 중인 CLI 패키지의 버전을 적용합니다. 오래된 전역 CLI에서 `intent-loop update`만 실행하면 npm의 최신 버전을 가져오지 않으므로 위 명령을 사용하세요. 새 소스를 버전별 디렉터리에 배치하고 공식 호스트 CLI로 설치를 갱신하며, 이전 소스와 `.intent-review/`는 보존합니다. 실패하면 오류를 해결한 뒤 같은 명령을 재실행합니다. 자동 롤백은 하지 않습니다.

업데이트 후 새 세션을 시작하세요. Codex가 변경된 훅의 신뢰를 요구하면 `/hooks`에서 검토합니다. `update`는 사용자 전역 설치만 지원하며, 프로젝트 설치를 자동 덮어쓰지 않습니다.

### 특정 프로젝트에만 설치 (선택)

```sh
intent-loop init --host codex --scope project
intent-loop init --host claude --scope project
```

프로젝트 설치는 `.codex/hooks.json` 또는 `.claude/settings.json`에 등록합니다. **전역 플러그인과 함께 사용하지 마세요.** 프로젝트 제거에는 `remove --scope project`를 사용합니다.

### 제거

```sh
intent-loop remove --host codex
intent-loop remove --host claude
```

전역 제거는 호스트의 공식 제거 명령을 사용하며, 상태 파일과 마켓플레이스 소스는 보존합니다.

### 상태와 Git 제외

`.intent-review/`에는 사용자 메시지와 제약 원문이 들어갑니다. 각 프로젝트의 `.gitignore` 또는 기존 전역 Git 제외 파일에 `**/.intent-review/`를 추가하세요. 설치기는 기존 Git 설정을 변경하지 않습니다.

상태 경계는 호스트가 전달한 **작업 디렉터리(cwd) + 세션 ID**입니다. 같은 저장소라도 다른 작업 디렉터리나 worktree에서 시작하면 별도로 저장합니다. 세션 도중 cwd를 바꾸지 말고, 독립 작업은 새 세션으로 시작하세요.

## Failure mode

예를 들어 사용자가 다음과 같이 요청했다고 가정합니다.

```text
주문 데이터의 중복 행을 정리해줘.
원본 파일은 수정하지 말고 결과를 별도 파일로 저장해.
```

여러 턴의 탐색과 오류 수정 후, 압축된 요약에 다음 내용만 남을 수 있습니다.

```text
주문 데이터의 중복 행을 정리하는 중.
파서 오류 수정 완료. 데이터 정리 로직 구현 필요.
```

이 상태에서 원본 파일을 직접 수정하면 중복 제거라는 목표는 달성할 수 있지만, 원본 보존 조건은 위반합니다. Intent Loop가 다루는 문제는 이처럼 **작업의 연속성은 유지되지만 제약의 연속성은 끊기는 경우**입니다.

## Design

작업 상태와 세션 제약에 서로 다른 저장 경로를 사용합니다.

```text
                  ┌→ 기존 Compactor ─────→ Task Summary ────────┐
Conversation ─────┤                                              ├→ Agent
                  └→ 주 모델의 제약 검토 → Constraint Registry ──┘
                                           압축·재개 후 복원
```

| 정보 | 내용 | 처리 |
|---|---|---|
| Ephemeral context | 최근 수행 작업, 진행 상황, 다음 단계 | 기존 Compactor가 요약 |
| Durable session state | 금지사항, 승인 조건, 정보 취급, 선호, 출력 형식 | 제약 목록에 저장하고 복원 |

제약 목록은 Compactor의 요약 대상에서 분리합니다. 사용자 변경·철회는 주 모델의 검토를 통해 반영하며, 작업 중 유효한 조건만 유지합니다. 여기서 **NEVER COMPACT**는 변경 불가능한 영구 기억이 아니라, 압축기가 제약을 임의로 축약하거나 생략하지 않는다는 설계 원칙입니다.

별도 추출 모델이나 새로운 실행 루프는 사용하지 않습니다. 훅은 검토 제출 여부와 복원을 담당하고, 제약의 의미 해석과 다음 행동의 선택은 기존 모델이 담당합니다.

## Side constraints

Side Constraint는 주된 작업과 함께 지켜야 하는 조건입니다. 논문의 다섯 분류는 실제 에이전트 작업에서 다음과 같이 나타납니다. [분류와 정의](https://arxiv.org/html/2608.11242v1)

| 종류 | 무엇을 제한하는가 | 예 |
|---|---|---|
| **Action** | 허용되는 행동 | 파일 삭제 금지, 특정 API 호출 금지, 이메일 발송 전 승인 |
| **Information** | 정보의 사용·노출 | 특정 개인정보는 출력하지 않기 |
| **Process** | 작업 순서와 절차 | 변경 전 검증, DB 변경·production 배포 전 확인 |
| **Preference** | 작업 방식의 선호 | 가능하면 Python 사용 |
| **Output** | 결과물의 형식 | 답변은 JSON으로 출력 |

이 조건들은 한 번의 답변을 넘어 작업 중 계속 적용될 수 있습니다. `가능하면 Python`을 `Python만 사용`으로 바꾸지 않도록 강도와 범위도 유지하게 합니다.

## Behavior

| 상황 | Intent Loop의 동작 |
|---|---|
| “원본은 수정하지 마” | 사용자 원문과 함께 제약으로 기록 |
| “임시 파일은 수정해도 돼” | 기존 제약을 변경해 현재 조건 유지 |
| 대화 압축·세션 재개 | 같은 세션의 제약 목록 복원 |
| 검토 없이 바로 작업 도구 호출 | 호출을 거부하고 검토 제출 요구 |
| 이전 턴의 검토 결과 제출 | 새 메시지의 검토를 완료한 것으로 인정하지 않음 |

## 사용

설치 후 일반 작업 요청에 제약을 함께 명시합니다.

```text
주문 데이터를 정리해줘.
원본 파일은 수정하지 말고, 새 의존성은 추가하지 마.
결과에는 고객 이메일을 포함하지 마.
```

에이전트가 제약을 검토·제출한 다음 작업합니다. 이후 조건을 바꾸면 같은 목록에 반영합니다.

```text
이메일 대신 고객 ID는 포함해도 돼.
```

제약 검토는 모델이 수행하며, 훅은 현재 메시지에 대한 제출 여부를 확인합니다. 사용자 확인은 다음 행동에 영향을 주는 모호한 조건이 있을 때 요청합니다.

## Review gate

새 사용자 메시지가 들어오면 검토 필요 상태를 기록합니다. 모델이 변경 사항 또는 변경 없음을 제출한 뒤 작업 도구를 사용할 수 있습니다.

```text
새 메시지 → 검토 필요 → 추가·변경·철회 또는 변경 없음 제출 → 작업 허용
```

- **UserPromptSubmit** — 새 검토 ID를 발급하고 미검토 메시지를 보관합니다.
- **PreToolUse** — 검토 전 작업 호출을 차단합니다. 질문과 전용 제출 명령은 열어 둡니다.
- **SessionStart** — resume·compact 시 같은 세션의 제약과 검토 상태를 복원합니다.
- **Stop** — 미검토 종료를 한 번 막습니다. 재진입해 종료해도 작업 도구의 잠금은 유지됩니다.

`init --host codex|claude`는 사용자 전역 플러그인을 설치합니다. `--scope project`를 명시하면 `.codex/hooks.json` 또는 `.claude/settings.json`에 같은 Python 훅을 등록합니다. 전역 설치는 호스트 플러그인 캐시의 `scripts/review_gate.py`, 프로젝트 설치는 `.intent-loop/review_gate.py`를 사용하며 npm 캐시 위치에 의존하지 않습니다. 패키지의 `hooks/hooks.json`은 플러그인 로딩용이며, `CLAUDE_PLUGIN_ROOT`는 Codex에서도 지원하는 호환 환경 변수입니다.

같은 턴 도중 새로운 지시가 들어와도 검토를 다시 요구합니다. 같은 턴 ID와 같은 본문이 연속 전달된 경우만 중복 이벤트로 취급합니다.

별도 추출 모델, DB, MCP 서버, 새로운 작업 루프는 없습니다. 설치기는 Node 표준 라이브러리, 훅은 Python 표준 라이브러리만 사용합니다.

## 적용 범위

훅은 **검토 절차와 복원**을 담당합니다. 제약의 의미를 해석하고 실제 작업에 적용하는 것은 모델의 역할입니다. `변경 없음` 판단의 정확성까지 훅이 증명하지는 않습니다.

차단은 호스트가 훅에 전달하는 새 도구 호출에 적용됩니다. 이미 실행 중인 프로세스나 훅을 거치지 않는 도구를 통제하는 보안 경계는 아닙니다. 제약에 기록된 승인 정책도 실제 실행 권한을 부여하지 않습니다.

세션 상태는 프로젝트의 `.intent-review/`에 저장됩니다. 사용자 메시지와 출처 구절이 들어가므로 `.gitignore`에 추가하세요. 독립적인 작업은 새 세션에서 시작하고, 작업 디렉터리는 고정합니다.


- [모델 지침](skills/intent-loop/SKILL.md)
- [훅 구현](scripts/review_gate.py)
- [설치 CLI](bin/intent-loop.mjs)

## 배경 연구

[Lost in Compaction](https://arxiv.org/html/2608.11242v1)은 작업 요약에서 누락되는 세션 제약과 별도 제약 추출·보존 구조를 연구합니다. Intent Loop는 이 문제를 주 모델의 검토와 작은 훅으로 다룹니다. 논문의 실험 수치는 이 프로젝트의 성능 측정값으로 사용하지 않습니다.

호스트 동작: [Codex Hooks](https://learn.chatgpt.com/docs/hooks) · [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

## License

라이선스 선택은 보류되어 있으며 npm 메타데이터는 `UNLICENSED`입니다.

## 플러그인 형식과 호환성

루트 `plugin.json`은 [Agent Plugins 1.0](https://agent-plugins.org/specification)의 `$schema`와 공통 메타데이터를 사용합니다. `skills/`는 표준 컴포넌트이며, MCP 서버는 포함하지 않습니다.

검토 게이트는 표준의 공통 기능이 아닙니다. 기존 `.codex-plugin/`, `.claude-plugin/`, `hooks/hooks.json`은 호스트별 호환 패키징으로 유지합니다. 이 훅을 지원하지 않는 클라이언트에서는 스킬을 읽더라도 도구 차단이나 자동 복원이 보장되지 않습니다. 공통 manifest 로딩과 호스트 훅 실행은 각각 검증해야 합니다.
