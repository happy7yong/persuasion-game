// 가치 실험: 평가 전용 Core 변형. 주지 않으면 서비스 프롬프트와 같아야 한다 (기준선 보존).
import { describe, expect, it } from "vitest";
import { coreFor, withCoreAddition } from "./content.js";
import { buildNpcPrompt } from "./npc.js";
import { newGame } from "./rules.js";

// 실험용 단락은 Core에 이미 들어간 가치 단락(consolidate@2)과 겹치지 않는 문장으로 시험한다
const ADD = "테스트용 단락: 이 문장은 Core에 없다.";
const state = newGame("value", 0, false, "m");

describe("Core 변형", () => {
  it("변형이 없으면 서비스 프롬프트와 같다", () => {
    expect(buildNpcPrompt(state, "미안해", null, undefined, {})).toEqual(buildNpcPrompt(state, "미안해", null));
  });

  it("두 조건은 단락 하나만 다르고, 그 단락은 '중요하게 생각하는 것' 절 끝·'지금 상태' 절 바로 앞에 들어간다", () => {
    const base = buildNpcPrompt(state, "미안해", null);
    const value = buildNpcPrompt(state, "미안해", null, undefined, { coreAddition: ADD });
    expect(value.user).toBe(base.user);
    expect(value.system.replace(`\n\n${ADD}`, "")).toBe(base.system);
    const core = withCoreAddition(coreFor("m"), ADD);
    expect(core.indexOf(ADD)).toBeGreaterThan(core.indexOf("## 중요하게 생각하는 것"));
    expect(core.indexOf(ADD)).toBeLessThan(core.indexOf("## 지금 상태"));
  });

  it("서아 Core에도 같은 자리에 들어간다", () => {
    const core = withCoreAddition(coreFor("f"), ADD);
    expect(core.indexOf(ADD)).toBeLessThan(core.indexOf("## 지금 서아의 상태"));
  });

  it("consolidate@2: 윤재 Core에는 가치 단락이 들어 있고 서아 Core에는 없다", () => {
    const value = "윤재는 서로의 상황과 감정을 존중하는 관계를 중요하게 여긴다.";
    const yunjae = coreFor("m");
    expect(yunjae).toContain(value);
    expect(yunjae.indexOf(value)).toBeGreaterThan(yunjae.indexOf("## 중요하게 생각하는 것"));
    expect(yunjae.indexOf(value)).toBeLessThan(yunjae.indexOf("## 지금 상태"));
    expect(coreFor("f")).not.toContain("서로의 상황과 감정을 존중하는 관계");
  });
});
