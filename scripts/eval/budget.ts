// 평가 비용 보호 (순수 로직, 유료 API 없이 테스트한다).
// - 실행 전: 예정 호출 수와 예상 비용을 계산하고, 기본 $0.10이 넘으면 --yes를 요구한다.
// - 실행 중: 호출 전에 "이번 호출의 예상 비용"을 더해도 상한(--max-usd) 안인지 확인하고, 호출 후에는 실제 비용을 누적한다.
// - 한계: 이미 보낸 요청은 멈출 수 없다. 동시에 진행 중인 요청과, 예상보다 비싸게 끝난 요청 때문에
//   실제 비용이 상한을 약간(동시 작업 수 × 한 작업의 최대 비용 정도) 넘을 수 있다.
// - 비용 정보가 오지 않으면 예상 비용으로 대신 세고, 연속해서 오지 않거나 API가 연속 실패하면 멈춘다
//   (무제한으로 계속 부르지 않게).

export type CallKind = "turn_frame" | "npc_turn" | "scene_check";

/**
 * 호출 한 번의 예상 비용 (USD). 2026-11-22 기준선의 실제 평균, 모델 gpt-5.4-mini.
 * turn_frame $0.1870/100회 · npc_turn $0.1955/79회 · scene_check $0.0268/42회.
 */
export const BASE_ESTIMATE: Record<CallKind, number> = { turn_frame: 0.00187, npc_turn: 0.00247, scene_check: 0.00064 };

/** 모델별 호출 예상 배율: Mini 1 · luna 0.7 · Terra와 모르는 모델 5 */
export function estimatesFor(models: Record<CallKind, string>): Record<CallKind, number> {
  // luna: 2026-11-24 실측 대사 호출당 약 $0.0016 (Mini 기준선 $0.00247의 약 0.65배). 모르는 모델은 보수적으로 5배
  const factor = (m: string) => (/gpt-5\.4-mini/.test(m) ? 1 : /gpt-5\.6-luna/.test(m) ? 0.7 : 5);
  return {
    turn_frame: BASE_ESTIMATE.turn_frame * factor(models.turn_frame),
    npc_turn: BASE_ESTIMATE.npc_turn * factor(models.npc_turn),
    scene_check: BASE_ESTIMATE.scene_check * factor(models.scene_check),
  };
}

/** 리플레이 한 마디: 1차 1회 + 대사 평균 1.15회(최대 2) + 판정 평균 0.45회(최대 2). 비율은 기준선에서 잰 값 */
export function turnEstimate(e: Record<CallKind, number>) {
  return {
    expected: e.turn_frame + 1.15 * e.npc_turn + 0.45 * e.scene_check,
    max: e.turn_frame + 2 * e.npc_turn + 2 * e.scene_check,
    expectedCalls: 1 + 1.15 + 0.45,
    maxCalls: 1 + 2 + 2,
  };
}

export interface Plan {
  /** 사람이 읽을 항목별 설명 */
  lines: string[];
  expectedUsd: number;
  maxUsd: number;
  expectedCalls: number;
  maxCalls: number;
}

export const emptyPlan = (): Plan => ({ lines: [], expectedUsd: 0, maxUsd: 0, expectedCalls: 0, maxCalls: 0 });
export function addToPlan(p: Plan, label: string, n: number, per: { expected: number; max: number; expectedCalls: number; maxCalls: number }) {
  if (n <= 0) return;
  p.lines.push(`${label}: ${n} × (예상 $${per.expected.toFixed(4)}, 최대 $${per.max.toFixed(4)})`);
  p.expectedUsd += n * per.expected;
  p.maxUsd += n * per.max;
  p.expectedCalls += n * per.expectedCalls;
  p.maxCalls += n * per.maxCalls;
}

/** 실행해도 되는가: 예상 비용이 기준을 넘으면 --yes 필요 */
export function gate(plan: Plan, opts: { yes: boolean; confirmAboveUsd?: number }): { ok: true } | { ok: false; reason: string } {
  const limit = opts.confirmAboveUsd ?? 0.1;
  if (plan.expectedUsd > limit && !opts.yes) return { ok: false, reason: `예상 비용 $${plan.expectedUsd.toFixed(4)}가 $${limit.toFixed(2)}를 넘어요. 실행하려면 --yes를 붙이세요.` };
  return { ok: true };
}

/** --max-usd를 주지 않았을 때의 상한: 예상의 1.5배 (최소 $0.02). 무제한은 없다 */
export const defaultMaxUsd = (plan: Plan) => Math.max(0.02, plan.expectedUsd * 1.5);

export interface UsageLike {
  usage: { cost: number | null } | null;
  result: string;
}

export class BudgetStop extends Error {}

export class Budget {
  spent = 0;
  calls = 0;
  /** 비용 정보 없이 끝난 호출 (예상 비용으로 대신 셈) */
  missingCost = 0;
  stopped: string | null = null;
  private consecutiveMissing = 0;
  private consecutiveFailures = 0;

  constructor(
    readonly maxUsd: number,
    readonly estimates: Record<CallKind, number>,
    readonly limits = { consecutiveMissing: 3, consecutiveFailures: 3 },
  ) {}

  /** 호출(또는 리플레이 한 마디) 전에: 이 금액을 더해도 상한 안인가. 아니면 멈춤 상태가 된다 */
  allow(nextCostUsd: number): boolean {
    if (this.stopped) return false;
    if (this.spent + nextCostUsd > this.maxUsd) {
      this.stopped = `상한 $${this.maxUsd.toFixed(4)}: 지금까지 $${this.spent.toFixed(4)} + 다음 예상 $${nextCostUsd.toFixed(4)}`;
      return false;
    }
    return true;
  }

  /** 호출 후: 실제 비용을 누적한다. 비용이 없으면 예상으로 대신 세고, 연속 누락·연속 실패면 멈춘다 */
  record(kind: CallKind, attempts: readonly UsageLike[]) {
    for (const a of attempts) {
      this.calls++;
      const failed = a.result !== "ok" && !a.result.startsWith("invalid_output");
      if (failed && a.usage?.cost == null) {
        // 요청 자체가 실패 (http·timeout 등): 보통 청구되지 않지만, 계속 실패하면 키·한도 문제일 수 있다
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.limits.consecutiveFailures) this.stopped ??= `API 호출이 연속 ${this.consecutiveFailures}회 실패 (${a.result}). 키 한도나 네트워크를 확인하세요`;
        continue;
      }
      this.consecutiveFailures = 0;
      const cost = a.usage?.cost;
      if (cost == null) {
        this.spent += this.estimates[kind];
        this.missingCost++;
        this.consecutiveMissing++;
        if (this.consecutiveMissing >= this.limits.consecutiveMissing) this.stopped ??= `비용 정보를 연속 ${this.consecutiveMissing}회 받지 못함 (예상 비용으로 대신 세는 중). 사용량을 확인할 수 없어 멈춰요`;
      } else {
        this.spent += cost;
        this.consecutiveMissing = 0;
      }
    }
    if (!this.stopped && this.spent > this.maxUsd) this.stopped = `상한 $${this.maxUsd.toFixed(4)} 초과: 실제 $${this.spent.toFixed(4)} (진행 중이던 요청 때문)`;
  }
}
