// 모델 운영 (docs/dialogue-architecture.md §14.12): 배포 기본값은 그대로, 로컬 개발·평가만 Mini가 기본.
import { afterEach, describe, expect, it } from "vitest";
import { applyDevModelDefaults, DEV_MODEL, modelConfig, PRODUCTION_DIALOGUE_MODEL } from "./model-config.js";

const KEYS = ["NPC_MODEL", "NPC_DIALOGUE_MODEL", "FRAME_MODEL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clear = () => KEYS.forEach((k) => delete process.env[k]);

describe("모델 기본값", () => {
  it("환경 변수가 없는 배포 함수: 대사는 Terra(main과 같음), 나머지는 Mini", () => {
    clear();
    expect(PRODUCTION_DIALOGUE_MODEL).toBe("openai/gpt-5.6-terra");
    expect(modelConfig("npc_turn").model).toBe(PRODUCTION_DIALOGUE_MODEL);
    expect(modelConfig("turn_frame").model).toBe(DEV_MODEL);
    expect(modelConfig("scene_check").model).toBe(DEV_MODEL);
  });

  it("로컬 개발·평가: 비어 있으면 모든 호출이 Mini", () => {
    clear();
    applyDevModelDefaults();
    for (const c of ["turn_frame", "npc_turn", "scene_check", "belief", "headline"] as const) expect(modelConfig(c).model).toBe(DEV_MODEL);
  });

  it("로컬에서도 직접 정한 값(Terra 비교 실행)은 덮어쓰지 않는다", () => {
    clear();
    process.env.NPC_DIALOGUE_MODEL = PRODUCTION_DIALOGUE_MODEL;
    applyDevModelDefaults();
    expect(modelConfig("npc_turn").model).toBe(PRODUCTION_DIALOGUE_MODEL);
    expect(modelConfig("turn_frame").model).toBe(DEV_MODEL);
  });
});
