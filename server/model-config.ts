// 호출 종류별 모델 설정 (relationship-engine의 config/llm-models.json, D-049·D-079 방식).
// 비밀값은 없다. 모델 이름만 환경 변수로 바꿀 수 있다.
//
// 시간 예산: Vercel 함수 상한(vercel.json maxDuration 60초) 안에서 "시도 2회 + 저장"이 끝나야 한다.
// 두 번째 시도는 남은 예산이 timeoutMs 이상일 때만 시작한다 (withRetry).

export type CallType = "npc_turn" | "ending";

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
  if (call === "npc_turn") {
    return {
      model: process.env.NPC_MODEL || "openai/gpt-5.4-mini",
      maxTokens: 700,
      timeoutMs: 22_000,
      budgetMs: 48_000,
      maxAttempts: 2,
      temperature: 0.8,
      reasoningNone: true,
    };
  }
  return {
    model: process.env.ENDING_MODEL || process.env.NPC_MODEL || "openai/gpt-5.4-mini",
    maxTokens: 1600,
    timeoutMs: 25_000,
    budgetMs: 52_000,
    maxAttempts: 2,
    temperature: 0.95,
    reasoningNone: true,
  };
}
