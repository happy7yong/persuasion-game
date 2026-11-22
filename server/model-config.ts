// 호출 종류별 모델 설정 (relationship-engine의 config/llm-models.json, D-049·D-079 방식).
// 비밀값은 없다. 모델 이름만 환경 변수로 바꿀 수 있다.
//
// 시간 예산: Vercel 함수 상한(vercel.json maxDuration 60초) 안에서 "시도 2회 + 저장"이 끝나야 한다.
// 두 번째 시도는 남은 예산이 timeoutMs 이상일 때만 시작한다 (withRetry).

export type CallType = "turn_frame" | "npc_turn" | "belief" | "headline";

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

export function modelConfig(call: CallType): CallModelConfig {
  // 대사 전 해석 단계. 짧은 구조화 작업이므로 지연·비용을 작게 고정한다.
  if (call === "turn_frame") {
    return {
      model: process.env.NPC_MODEL || "openai/gpt-5.4-mini",
      // 상태 변경안까지 함께 반환하므로 기존 관계 해석보다 여유가 필요하다.
      maxTokens: 500,
      timeoutMs: 8_000,
      budgetMs: 9_000,
      maxAttempts: 1,
      temperature: 0.2,
      reasoningNone: true,
    };
  }
  if (call === "npc_turn") {
    return {
      model: process.env.NPC_MODEL || "openai/gpt-5.4-mini",
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
