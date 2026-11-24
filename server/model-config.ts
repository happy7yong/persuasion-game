// 호출 종류별 모델 설정 (relationship-engine의 config/llm-models.json, D-049·D-079 방식).
// 비밀값은 없다. 모델 이름만 환경 변수로 바꿀 수 있다.
//
// 시간 예산: Vercel 함수 상한(vercel.json maxDuration 60초) 안에서 "시도 2회 + 저장"이 끝나야 한다.
// 두 번째 시도는 남은 예산이 timeoutMs 이상일 때만 시작한다 (withRetry).

export type CallType = "turn_frame" | "npc_turn" | "scene_check" | "belief" | "headline";

export interface CallModelConfig {
  readonly model: string;
  readonly maxTokens: number;
  /** 시도 한 번의 하드 타임아웃 */
  readonly timeoutMs: number;
  /** 재시도를 포함한 이 호출 전체의 예산 */
  readonly budgetMs: number;
  readonly maxAttempts: number;
  readonly temperature: number;
  /** gpt-5 계열 등에서 추론을 끄면 응답이 빨라지고 비용이 준다 (B와 같은 설정) */
  readonly reasoningNone: boolean;
}

export const FUNCTION_MAX_DURATION_MS = 60_000;

/**
 * 배포 환경의 대사 모델 기본값. 2026-11-24 Terra → luna (docs/eval/luna-2026-11-24.md).
 * luna는 Terra 단가의 10분의 1이고, 같은 대본 비교에서 사용자가 Mini·Terra보다 자연스럽다고 판단했다.
 * 주의: 실제 배포는 main 브랜치와 Vercel 환경 변수(NPC_DIALOGUE_MODEL·NPC_MODEL이 있으면 그것이 우선)를 따른다.
 */
export const PRODUCTION_DIALOGUE_MODEL = "openai/gpt-5.6-luna";
/** 로컬 개발·평가에서 대사 외 호출(1차 분석·장면 판정·결과 화면)의 기본 모델 (docs/dialogue-architecture.md §14.12). luna로 바꾸려면 장부 정확도 평가가 먼저다 */
export const DEV_MODEL = "openai/gpt-5.4-mini";

/**
 * 로컬 개발 서버와 scripts/(eval·play·tone)에서만 부른다. 배포 함수는 부르지 않는다.
 * 모델 환경 변수가 비어 있으면 대사는 배포와 같은 luna, 나머지는 Mini를 넣는다. 이미 정한 값(예: 다른 모델 비교 실행)은 그대로 둔다.
 */
export function applyDevModelDefaults(env: Record<string, string | undefined> = process.env): void {
  env.NPC_MODEL ||= DEV_MODEL;
  env.NPC_DIALOGUE_MODEL ||= PRODUCTION_DIALOGUE_MODEL;
}

export function modelConfig(call: CallType): CallModelConfig {
  // 대사 전 해석 단계. 짧은 구조화 작업이므로 지연·비용을 작게 고정한다.
  if (call === "turn_frame") {
    return {
      // 상태 판정은 짧은 구조화 작업이므로 비용 효율 모델을 유지한다.
      model: process.env.FRAME_MODEL || process.env.NPC_MODEL || "openai/gpt-5.4-mini",
      // 관계 상태·대화 연결·변경안을 함께 반환하므로 출력이 잘리지 않게 여유를 둔다.
      maxTokens: 800,
      timeoutMs: 8_000,
      budgetMs: 9_000,
      maxAttempts: 1,
      temperature: 0.2,
      reasoningNone: true,
    };
  }
  // V3 장면 판정: 키워드에 걸린 대사만, 한 번, 짧게. 실패하면 "애매"로 기록하고 넘어간다.
  if (call === "scene_check") {
    return {
      model: process.env.NPC_MODEL || "openai/gpt-5.4-mini",
      maxTokens: 120,
      timeoutMs: 6_000,
      budgetMs: 6_000,
      maxAttempts: 1,
      temperature: 0,
      reasoningNone: true,
    };
  }
  if (call === "npc_turn") {
    return {
      // 실제 대사 모델. 기본값은 배포와 같은 luna다 (2026-11-24 Terra에서 바꿈. 이 값을 바꾸면 배포 모델이 바뀐다).
      // 로컬 개발·평가는 applyDevModelDefaults로 Mini를 쓴다 (docs/dialogue-architecture.md §14.12).
      model: process.env.NPC_DIALOGUE_MODEL || process.env.NPC_MODEL || PRODUCTION_DIALOGUE_MODEL,
      maxTokens: 700,
      timeoutMs: 21_000,
      budgetMs: 43_000,
      maxAttempts: 2,
      temperature: 0.8,
      reasoningNone: true,
    };
  }
  // 은하 신문 1면: 대화가 끝난 뒤 한 번. 리포트를 먼저 보여 주고 뒤에서 생성한다.
  if (call === "headline") {
    return {
      model: process.env.HEADLINE_MODEL || process.env.NPC_MODEL || "openai/gpt-5.4-mini",
      maxTokens: 500,
      timeoutMs: 20_000,
      budgetMs: 45_000,
      maxAttempts: 2,
      temperature: 0.9,
      reasoningNone: true,
    };
  }
  // "내가 본 너": 대화가 끝난 뒤 한 번. 리포트를 먼저 보여 주고 뒤에서 생성한다.
  return {
    model: process.env.BELIEF_MODEL || process.env.NPC_MODEL || "openai/gpt-5.4-mini",
    maxTokens: 800,
    timeoutMs: 24_000,
    budgetMs: 50_000,
    maxAttempts: 2,
    temperature: 0.7,
    reasoningNone: true,
  };
}
