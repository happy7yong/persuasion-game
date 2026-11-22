// 평가 지표가 의도대로 세는지 (평가 장치 자체의 회귀 테스트).
import { describe, expect, it } from "vitest";
import { agreement, distinctRatio, echoOverlaps, factsSignature, hasQuestion, motifHits, rawFactsCounts, summarize } from "./metrics";

const d = (content: string) => ({ type: "dialogue" as const, content });
const n = (content: string) => ({ type: "narration" as const, content });

describe("평가 지표", () => {
  it("질문은 V4와 같은 기준 (대사가 물음표로 끝남)", () => {
    expect(hasQuestion([d("뭐가 제일 서운했어?")])).toBe(true);
    expect(hasQuestion([d("그래."), n("잔을 본다?")])).toBe(false);
  });
  it("반복 표현을 대사·행동 묘사에서 따로 센다", () => {
    expect(motifHits([n("빨대를 돌린다."), d("근데 일부러 그런 건 아니었어.")])).toEqual(["행동: 라떼·빨대·잔·컵", "대사: 일부러 … 아니", "대사: 문두 근데·다만·그래도"]);
    expect(motifHits([d("응, 고마워.")])).toEqual([]);
  });
  it("다양성과 반복 겹침", () => {
    expect(distinctRatio(["가나다", "가나다"])).toBe(0.5);
    const e = echoOverlaps(["늦을 땐 미리 말할게", "응 고마워", "늦을 땐 미리 말할게"]);
    expect(e[0]).toBe(0);
    expect(e[2]).toBe(1);
  });
  it("1차 원래 출력의 항목 수를 센다 (검증 전)", () => {
    expect(rawFactsCounts('{"npcLast":[1],"npcResolved":[],"acts":[1,2],"playerNew":[1,2],"playerResolved":[1]}')).toEqual({ items: 3, resolves: 1, acts: 2 });
    expect(rawFactsCounts("not json")).toBeNull();
  });
  it("기록 요약은 새 항목 id 대신 누가·종류만 보고, 일치율을 낸다", () => {
    const f = (id: string) => ({ v: 2 as const, added: [{ id, by: "player" as const, kind: "commitment" as const, issue: "intent-trust" as const, text: "-", quote: "-", turn: 1, status: "open" as const }], resolved: [{ id: "L2", by: "player" as const, status: "accepted" as const, quote: "-" }], acts: [{ act: "promise" as const, quote: "-", refersTo: "" }], evaluation: { suggested_drop: 0, labels: [], reason: "-", noticed: "-", evidence: [] } });
    const known = new Set(["L1", "L2", "L3"]);
    expect(factsSignature(f("L4"), known)).toBe(factsSignature(f("L5"), known));
    expect(agreement(["a", "a", "b"])).toEqual({ modal: "a", rate: 2 / 3 });
    expect(summarize([1, 3]).mean).toBe(2);
  });
});
