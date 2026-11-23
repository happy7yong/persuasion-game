// 경험 실험 결과 정리 (LLM 없음): 가린 비교표가 조건·속마음을 드러내지 않는지, 정답 키로 되돌릴 수 있는지.
import { describe, expect, it } from "vitest";
import { EXPERIENCES } from "./cases";
import { blindSheet, mentionsPast, reviewSheet, summaryLines, type ExpCell, type ExpGen } from "./experience";

const gen = (cond: ExpGen["cond"], run: number, line: string): ExpGen => ({
  cond,
  run,
  ok: true,
  drafts: [{ attempt: 1, result: "ok", beats: [{ type: "dialogue", content: line }], violations: [] }],
  final: [{ type: "dialogue", content: line }],
  heard: `heard-${cond}`,
  focus: `focus-${cond}`,
  belief: `belief-${cond}`,
  standard: [`standard-${cond}`],
  shift: [],
  want: "",
});
const cell: ExpCell = { key: "same", line: "기다릴게", about: "-", factsSummary: "-", gens: [gen("A", 1, "저번에도 그랬잖아"), gen("B", 1, "고마워"), gen("C", 1, "알았어")] };
const memories = Object.fromEntries(Object.entries(EXPERIENCES).map(([k, v]) => [k, v.memory])) as Record<"A" | "B" | "C", string | null>;

describe("경험 실험 결과 정리", () => {
  const ctx = { conversation: ["> **플레이어:** 오늘 연락 없어서 많이 서운했어"], model: "openai/gpt-5.4-mini", runs: 1 };
  it("가린 비교표는 앞 대화·번호·평가 칸과 최종 대사만 보이고, 조건 배정과 속마음·과거 언급 표시는 숨긴다", () => {
    const { md, key } = blindSheet([cell, { ...cell, key: "transfer", line: "서운해" }], 3, ctx);
    expect(md).not.toMatch(/heard-|focus-|belief-|standard-|〔|과거 언급/);
    expect(md).toContain("오늘 연락 없어서 많이 서운했어");
    expect(md).toContain("| 번호 | 윤재의 반응 | 추측 (A/B/C/?) | 자연스러움 | Core 부합 | 메모 |");
    for (const l of ["저번에도 그랬잖아", "고마워", "알았어"]) expect(md).toContain(` | ${l} |`);
    // 번호는 두 발화에 걸쳐 1부터 이어진다
    expect(Object.keys(key)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(Object.values(key).filter((k) => k.line === "same").map((k) => k.cond).sort()).toEqual(["A", "B", "C"]);
    expect(blindSheet([cell], 3, ctx).key).toEqual(blindSheet([cell], 3, ctx).key);
  });

  it("검토표는 조건별 경험 원문과 속마음·대사를 함께 보인다", () => {
    const md = reviewSheet([cell], memories);
    expect(md).toContain("(블록 없음)");
    expect(md).toContain("재촉 안 하고 기다릴게");
    expect(md).toContain("focus(가장 크게 본 것): focus-A");
    expect(md).toContain("〔대사에서 과거 언급〕");
    expect(md).toContain("반대 가능성: A에서 새 말을 받아들일 여지를 남겼나");
    expect(md).toContain("평가 기준이 바뀌었다고 바로 결론 내리지 않는다");
  });

  it("과거 언급 표시와 요약", () => {
    expect(mentionsPast("저번에도 그랬잖아")).toBe(true);
    expect(mentionsPast("알았어")).toBe(false);
    expect(summaryLines([cell]).join("\n")).toContain("| 대사에서 과거 언급 (거친 표시) | 1/1 | 0/1 | 0/1 |");
  });

  it("A·B 경험은 같은 약속 문장으로 시작하고, 교훈이나 감정을 쓰지 않는다", () => {
    expect(EXPERIENCES.A.memory!.split("\n")[0]).toBe(EXPERIENCES.B.memory!.split("\n")[0]);
    expect(EXPERIENCES.C.memory).toBeNull();
    for (const m of [EXPERIENCES.A.memory!, EXPERIENCES.B.memory!]) expect(m).not.toMatch(/믿게|느꼈|서운|화가|실망|고마웠/);
  });
});
