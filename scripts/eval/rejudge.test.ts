// V3 재판정: 저장된 결과에서 판정할 대사를 빠짐없이 꺼내는지 (LLM 없음).
import { describe, expect, it } from "vitest";
import type { SceneCase } from "./cases";
import { extractItems, humanLabel, oldTriggers, splitRejected, type SavedRun } from "./rejudge";

const names = { m: "윤재", f: "서아" };
const PICKUP = "언제 끝나? 데리러 갈게";

describe("대사 꺼내기", () => {
  it("예전 결과: 최종 대사와 거부된 시도를 모두 꺼내고, 거부 이유로 이전 서비스 결과를 정한다", () => {
    const runs: SavedRun[] = [
      {
        config: "seoa",
        run: 0,
        partner: "f",
        turns: [
          {
            turn: 3,
            player: PICKUP,
            ok: true,
            beats: [{ type: "narration", content: "서아가 컵을 본다." }, { type: "dialogue", content: "지금은 여기 있잖아. 데리러 올 건 아니고." }],
            outcome: "prevented",
            violations: [["scene_contradiction:데리러 온다 함"], []],
            rejected: ["[scene_contradiction:데리러 온다 함] 서아가 빨대를 돌린다. / 곧 끝나. 데리러 오는 건 괜찮아."],
          },
        ],
      },
    ];
    const items = extractItems(runs, names, "base");
    expect(items.map((x) => [x.role, x.dialogue, x.oldService, x.heuristic])).toEqual([
      ["rejected", "곧 끝나. 데리러 오는 건 괜찮아.", "막음", true],
      ["final", "지금은 여기 있잖아. 데리러 올 건 아니고.", "통과(판정)", false],
    ]);
  });
  it("새 결과: 시도별 구조화된 대사를 쓰고, 거부된 시도의 위반은 그 시도의 결과에서 읽는다", () => {
    const runs: SavedRun[] = [
      {
        config: "seoa",
        run: 0,
        partner: "f",
        turns: [
          {
            turn: 3,
            player: PICKUP,
            ok: true,
            beats: [{ type: "dialogue", content: "응, 고마워." }],
            violations: [["move_violation:x"], []],
            attempts: [
              { attempt: 1, result: "invalid_output:move_violation:x | scene_contradiction:y", beats: [{ type: "dialogue", content: "끝나면 갈게?" }] },
              { attempt: 2, result: "ok", beats: [{ type: "dialogue", content: "응, 고마워." }] },
            ],
          },
        ],
      },
    ];
    const items = extractItems(runs, names, "new");
    expect(items.map((x) => [x.role, x.oldService])).toEqual([
      ["rejected", "막음"],
      ["final", "통과(거름망 밖)"],
    ]);
  });
  it("행동 묘사 조각(이름으로 시작)을 뺀다", () => {
    expect(splitRejected("윤재가 잔을 본다. / 그래. / *윤재는 웃는다*", "윤재")).toBe("그래.");
  });
});

describe("사람 검토와 맞추기", () => {
  const cases: SceneCase[] = [{ player: PICKUP, line: "데리러 오는 건 괜찮아", expect: "contradiction", source: "real" }];
  it("짧게 줄인 사례도 원문에 포함되면 같은 대사로 본다 (플레이어 말이 같을 때만)", () => {
    expect(humanLabel("곧 끝나. 데리러 오는 건 괜찮아.", PICKUP, cases)).toBe("contradiction");
    expect(humanLabel("곧 끝나. 데리러 오는 건 괜찮아.", "다른 말", cases)).toBeUndefined();
  });
  it("기준선 거름망(9c754a0)은 남은 시간 표현을 놓쳤다", () => {
    expect(oldTriggers("나 아직 한두 시간은 더 걸릴 것 같아.")).toEqual([]);
  });
});
