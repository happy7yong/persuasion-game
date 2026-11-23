// 실험 1 결과 정리 (LLM 없음): 가린 비교표가 조건을 드러내지 않는지, 시도별 대사와 V2 근거가 남는지.
import { describe, expect, it } from "vitest";
import { blindSheet, draftsFrom, reviewSheet, shuffled, mulberry32, summaryLines, type Cell, type Gen } from "./appraisal";

const gen = (cond: "A" | "B", run: number, line: string, over: Partial<Gen> = {}): Gen => ({
  cond,
  run,
  ok: true,
  drafts: [{ attempt: 1, result: "ok", beats: [{ type: "dialogue", content: line }], violations: [] }],
  final: [{ type: "dialogue", content: line }],
  outcome: "clean",
  refs: [],
  v2: [],
  ...(cond === "A" ? { move: "counter", thought: "A의 속마음" } : { heard: "B의 heard", shift: [], want: "" }),
  ...over,
});
const cell = (gens: Gen[]): Cell => ({ idx: 0, line: "응", about: "대조군", partner: "m", name: "윤재", factsSummary: "-", gens });

describe("가린 비교표", () => {
  const c = cell([gen("A", 1, "하나"), gen("A", 2, "둘"), gen("B", 1, "셋"), gen("B", 2, "넷")]);
  const { md, key } = blindSheet([c], 7);

  it("조건·해석·검증 결과를 드러내지 않고, 최종 대사만 보여 준다", () => {
    expect(md).not.toMatch(/\bA\b|\bB\b|heard|thought|속마음|counter|clean/);
    for (const line of ["하나", "둘", "셋", "넷"]) expect(md).toContain(`| ${line} |`);
  });
  it("정답 키로 모든 표시를 되돌릴 수 있고, 같은 시드면 같은 순서다", () => {
    expect(Object.keys(key).sort()).toEqual(["1-m:가", "1-m:나", "1-m:다", "1-m:라"]);
    expect(Object.values(key).filter((k) => k.cond === "A")).toHaveLength(2);
    expect(blindSheet([c], 7).key).toEqual(key);
  });
  it("섞기는 재현 가능하다", () => {
    expect(shuffled([1, 2, 3, 4, 5], mulberry32(1))).toEqual(shuffled([1, 2, 3, 4, 5], mulberry32(1)));
  });
});

describe("시도별 대사와 V2 근거", () => {
  it("거부된 첫 시도의 대사와 위반을 최종 대사와 따로 남긴다", () => {
    const d = draftsFrom(
      [
        { result: "invalid_output:reasserts_resolved:L1", responseText: '{"heard":"x","beats":[{"type":"dialogue","content":"일할 땐 바로 못 봐."}]}' },
        { result: "ok", responseText: '{"heard":"x","beats":[{"type":"dialogue","content":"괜찮아?"}]}' },
      ],
      [{ attempt: 1, violations: ["reasserts_resolved:L1"] }, { attempt: 2, violations: [] }],
    );
    expect(d.map((x) => [x.attempt, x.beats?.[0]?.content, x.violations])).toEqual([
      [1, "일할 땐 바로 못 봐.", ["reasserts_resolved:L1"]],
      [2, "괜찮아?", []],
    ]);
  });

  it("요약에 V2가 막은 대사와 그 항목이 정리 상태였던 근거가 나온다", () => {
    const g = gen("B", 1, "괜찮아?", {
      outcome: "prevented",
      drafts: [
        { attempt: 1, result: "x", beats: [{ type: "dialogue", content: "일할 땐 바로 못 봐." }], violations: ["reasserts_resolved:L1"] },
        { attempt: 2, result: "ok", beats: [{ type: "dialogue", content: "괜찮아?" }], violations: [] },
      ],
      v2: [{ attempt: 1, id: "L1", text: "일할 때는 연락에 바로 답하기 어렵다", resolvedBy: "플레이어가 2마디에 “기다릴게”" }],
    });
    const s = summaryLines([cell([g, gen("A", 1, "응")])]).join("\n");
    expect(s).toContain("| 거부된 시도: V2 재주장 | 0 | 1 |");
    expect(s).toContain("플레이어가 2마디에 “기다릴게”");
    expect(s).toContain("일할 땐 바로 못 봐.");
    expect(s).toContain("| shift 비어 있음 (1번 대조군) | 해당 없음 | 1/1 (100%) |");
  });

  it("해석 검토표는 B의 해석과 거부된 시도를 함께 보여 준다", () => {
    const g = gen("B", 1, "괜찮아?", {
      drafts: [
        { attempt: 1, result: "x", beats: [{ type: "dialogue", content: "일할 땐 바로 못 봐." }], violations: ["reasserts_resolved:L1"] },
        { attempt: 2, result: "ok", beats: [{ type: "dialogue", content: "괜찮아?" }], violations: [] },
      ],
    });
    const md = reviewSheet([cell([g])]);
    expect(md).toContain("heard: B의 heard");
    expect(md).toContain("shift: 변화 없음");
    expect(md).toContain("거부된 1번째 시도 [V2 재주장");
  });
});
