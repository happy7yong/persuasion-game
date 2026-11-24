// 가치 실험 결과 정리 (LLM 없음): 가린 비교표가 조건·속마음을 드러내지 않는지, 정답 키로 되돌릴 수 있는지.
import { describe, expect, it } from "vitest";
import { blindSheet, reviewSheet, type ValueCell, type ValueGen } from "./value";

const gen = (cond: ValueGen["cond"], run: number, line: string): ValueGen => ({ cond, run, ok: true, drafts: [], final: [{ type: "dialogue", content: line }], move: "counter", thought: `속-${cond}` });
const cell = (idx: number): ValueCell => ({ idx, line: `말${idx}`, about: "-", facts: { suggested: 6, labels: ["apology"], reason: "r", noticed: "n", summary: "s" }, gens: [gen("base", 1, `기본${idx}`), gen("value", 1, `가치${idx}`)] });
const ctx = { kakao: ["10:12 나: 좋은 아침"], opening: ["> 윤재: 팀장님 얘기는 이따"], model: "openai/gpt-5.6-terra", runs: 1 };

describe("가치 실험 결과 정리", () => {
  it("가린 비교표는 조건·속마음·끝맺음·점수를 숨기고, 번호는 발화를 넘어 이어진다", () => {
    const { md, key } = blindSheet([cell(0), cell(1)], 5, ctx);
    expect(md).not.toMatch(/속-|base|value|가치 단락|counter|점수 제안/);
    expect(md).toContain("10:12 나: 좋은 아침");
    expect(Object.keys(key)).toEqual(["1", "2", "3", "4"]);
    expect(Object.values(key).filter((k) => k.idx === 0).map((k) => k.cond).sort()).toEqual(["base", "value"]);
    expect(blindSheet([cell(0), cell(1)], 5, ctx).key).toEqual(key);
  });

  it("검토표는 더한 단락·공통 제약·1차 점수·조건별 속마음을 보인다", () => {
    const md = reviewSheet([cell(0)], "가치 문장", ["첫 마디 끝맺음 제약"]);
    expect(md).toContain("> 가치 문장");
    expect(md).toContain("- 첫 마디 끝맺음 제약");
    expect(md).toContain("점수 제안 6");
    expect(md).toContain("속마음: 속-value");
  });
});
