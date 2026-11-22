// 공유 링크 읽기: 범위와 종류가 맞는 값만 친구 결과로 보여 준다.
import { describe, expect, it } from "vitest";
import { readSharedResult } from "./share";

describe("공유 링크", () => {
  it("값이 모두 맞으면 친구 결과를 읽는다", () => {
    expect(readSharedResult("?s=63&p=f&o=compromise&g=70")).toEqual({ partner: "f", npcName: "서아", shake: 63, successShake: 70, outcome: "compromise" });
  });
  it("하나라도 없거나 이상하면 보여 주지 않는다", () => {
    for (const q of ["", "?s=63&p=m&o=compromise", "?s=101&p=m&o=success&g=70", "?s=-1&p=m&o=success&g=70", "?s=6.5&p=m&o=success&g=70", "?s=63&p=x&o=success&g=70", "?s=63&p=m&o=win&g=70"]) {
      expect(readSharedResult(q)).toBeNull();
    }
  });
});
