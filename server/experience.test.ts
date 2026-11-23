// 경험 실험 (docs/appraisal-review.md §16): 실험 1 B 프롬프트에 경험 블록·판단 필드만 더한다.
// variant를 주지 않으면 실험 1 B와 같아야 한다 (기준선 보존).
import { describe, expect, it } from "vitest";
import { APPRAISAL_OUTPUT_FORMAT, EXPERIENCE_OUTPUT_FORMAT } from "./content.js";
import type { TurnFacts } from "./ledger.js";
import { buildAppraisalPrompt, JUDGED_APPRAISAL_JSON_SCHEMA, parseJudgedAppraisalOutput } from "./npc.js";
import { newGame, recordTurn } from "./rules.js";

const facts: TurnFacts = { v: 2, added: [], resolved: [], acts: [{ act: "promise", quote: "기다릴게", refersTo: "" }], evaluation: { suggested_drop: 0, labels: [], reason: "-", noticed: "-", evidence: [] } };
const state = recordTurn(newGame("exp", 0, false), { player: "오늘 연락 없어서 많이 서운했어", npc: [{ type: "dialogue", content: "일부러 그런 건 아니야." }], move: "counter", suggested: 0, labels: [] });
const LINE = "앞으로 회의 있는 날엔 재촉 안 하고 기다릴게. 진짜로.";

describe("경험 변형", () => {
  it("variant가 없으면 실험 1 B 프롬프트와 같다", () => {
    expect(buildAppraisalPrompt(state, LINE, facts, {})).toEqual(buildAppraisalPrompt(state, LINE, facts));
    expect(buildAppraisalPrompt(state, LINE, facts).system).toContain(APPRAISAL_OUTPUT_FORMAT);
    expect(buildAppraisalPrompt(state, LINE, facts).system).not.toContain("# 전에 있었던 일");
  });

  it("조건 사이에는 경험 블록만 다르다", () => {
    const c = buildAppraisalPrompt(state, LINE, facts, { judgement: true });
    const a = buildAppraisalPrompt(state, LINE, facts, { judgement: true, memory: "- 한 달 전 일" });
    expect(a.user).toBe(c.user);
    expect(a.system.replace("# 전에 있었던 일 (네 기억)\n- 한 달 전 일\n\n", "")).toBe(c.system);
    // 경험 블록은 매 마디 바뀌는 부분(듣기 전 마음) 바로 앞에 둔다
    expect(a.system.indexOf("# 전에 있었던 일")).toBeLessThan(a.system.indexOf("# 듣기 전 네 마음"));
    expect(a.system.indexOf("# 전에 있었던 일")).toBeGreaterThan(a.system.indexOf("# 무엇을 먼저 따르나"));
  });

  it("판단 필드 형식은 B 형식에 세 줄과 JSON 예시만 더한다", () => {
    expect(EXPERIENCE_OUTPUT_FORMAT).toContain("- focus:");
    expect(EXPERIENCE_OUTPUT_FORMAT).toContain("- belief:");
    expect(EXPERIENCE_OUTPUT_FORMAT).toContain("- standard:");
    const without = EXPERIENCE_OUTPUT_FORMAT.split("\n").filter((l) => !/^- (focus|belief|standard):/.test(l)).join("\n").replace('"focus":"...","belief":"...","standard":["...","..."],', "");
    expect(without).toBe(APPRAISAL_OUTPUT_FORMAT);
    expect(JUDGED_APPRAISAL_JSON_SCHEMA.required).toEqual(["heard", "focus", "belief", "standard", "shift", "want", "beats", "refs"]);
  });

  it("판단 필드가 없으면 거부한다", () => {
    const base = { heard: "h", shift: [], want: "", beats: [{ type: "dialogue", content: "응" }], refs: [] };
    expect(() => parseJudgedAppraisalOutput(base)).toThrow();
    expect(parseJudgedAppraisalOutput({ ...base, focus: "f", belief: "b", standard: ["s"] }).standard).toEqual(["s"]);
  });
});
