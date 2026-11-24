// 평가 비용 보호: 실제 유료 API를 부르지 않고 계산·실행 중단 조건만 확인한다.
import { describe, expect, it } from "vitest";
import { addToPlan, BASE_ESTIMATE, Budget, defaultMaxUsd, emptyPlan, estimatesFor, gate, turnEstimate } from "./budget";

const mini = { turn_frame: "openai/gpt-5.4-mini", npc_turn: "openai/gpt-5.4-mini", scene_check: "openai/gpt-5.4-mini" };
const ok = (cost: number | null) => ({ usage: { cost }, result: "ok" });

describe("계획과 확인", () => {
  it("리플레이 한 판(5마디)의 예상은 기준선 실제 판당 비용과 비슷하다 (약 $0.025)", () => {
    const t = turnEstimate(estimatesFor(mini));
    expect(5 * t.expected).toBeGreaterThan(0.02);
    expect(5 * t.expected).toBeLessThan(0.03);
    expect(t.max).toBeGreaterThan(t.expected);
  });
  it("대사 모델이 mini가 아니면 대사 호출 예상을 키운다", () => {
    expect(estimatesFor({ ...mini, npc_turn: "openai/gpt-5.6-terra" }).npc_turn).toBeCloseTo(BASE_ESTIMATE.npc_turn * 5);
    expect(estimatesFor({ ...mini, npc_turn: "openai/gpt-5.6-luna" }).npc_turn).toBeCloseTo(BASE_ESTIMATE.npc_turn * 0.7);
  });
  it("예상이 $0.10을 넘으면 --yes가 필요하다", () => {
    const p = emptyPlan();
    addToPlan(p, "판정", 100, { expected: 0.0005, max: 0.0005, expectedCalls: 1, maxCalls: 1 });
    expect(gate(p, { yes: false }).ok).toBe(true);
    addToPlan(p, "리플레이 마디", 30, { expected: 0.005, max: 0.008, expectedCalls: 2.6, maxCalls: 5 });
    expect(p.expectedUsd).toBeCloseTo(0.2);
    expect(gate(p, { yes: false }).ok).toBe(false);
    expect(gate(p, { yes: true }).ok).toBe(true);
  });
  it("상한을 주지 않으면 예상의 1.5배 (최소 $0.02), 무제한은 없다", () => {
    const p = emptyPlan();
    expect(defaultMaxUsd(p)).toBe(0.02);
    addToPlan(p, "x", 10, { expected: 0.01, max: 0.02, expectedCalls: 1, maxCalls: 1 });
    expect(defaultMaxUsd(p)).toBeCloseTo(0.15);
  });
});

describe("실행 중 상한", () => {
  const est = estimatesFor(mini);
  it("다음 호출의 예상까지 더해 상한을 넘으면 멈추고, 그 뒤로는 계속 거부한다", () => {
    const b = new Budget(0.01, est);
    expect(b.allow(0.004)).toBe(true);
    b.record("npc_turn", [ok(0.004)]);
    expect(b.allow(0.004)).toBe(true);
    b.record("npc_turn", [ok(0.004)]);
    expect(b.allow(0.004)).toBe(false);
    expect(b.stopped).toMatch(/상한/);
    expect(b.allow(0.0001)).toBe(false);
  });
  it("진행 중이던 요청 때문에 실제 비용이 상한을 넘으면 그 사실을 남긴다", () => {
    const b = new Budget(0.01, est);
    b.record("npc_turn", [ok(0.012)]);
    expect(b.stopped).toMatch(/초과/);
  });
  it("비용 정보가 없으면 예상으로 대신 세고, 연속 3회면 멈춘다 (무제한 실행 방지)", () => {
    const b = new Budget(1, est);
    b.record("scene_check", [ok(null), ok(null)]);
    expect(b.spent).toBeCloseTo(2 * est.scene_check);
    expect(b.stopped).toBeNull();
    b.record("scene_check", [ok(null)]);
    expect(b.stopped).toMatch(/비용 정보/);
    expect(b.missingCost).toBe(3);
  });
  it("API가 연속으로 실패하면 멈춘다 (키 한도 소진 등)", () => {
    const b = new Budget(1, est);
    const fail = { usage: null, result: "http:403" };
    b.record("npc_turn", [fail, fail]);
    expect(b.stopped).toBeNull();
    b.record("npc_turn", [fail]);
    expect(b.stopped).toMatch(/연속 3회 실패/);
    expect(b.spent).toBe(0);
  });
  it("응답을 받았지만 검사에서 거부된 시도(invalid_output)는 실패가 아니라 비용으로 센다", () => {
    const b = new Budget(1, est);
    b.record("npc_turn", [{ usage: { cost: 0.003 }, result: "invalid_output:scene_contradiction:x" }]);
    expect(b.spent).toBeCloseTo(0.003);
    expect(b.stopped).toBeNull();
  });
});
