// 연인 선택: 이름과 성별만 바뀌고 나머지(Core, 장면, 첫 대사)는 같아야 한다.
import { describe, expect, it } from "vitest";
import { coreFor, PARTNERS, rubricFor, scenarioFor, sceneFactsFor } from "./content.js";
import { buildEndingPrompt, planEnding } from "./ending.js";
import { buildNpcPrompt, scriptedReply } from "./npc.js";
import { newGame, recordTurn } from "./rules.js";

describe("연인 선택", () => {
  it("여자친구 서아의 프롬프트에는 윤재가 남지 않는다", () => {
    const s = newGame("f1", Date.now(), false, "f");
    const p = buildNpcPrompt(s, "안녕", "counter");
    expect(p.system + p.user).not.toContain("윤재");
    expect(p.system).toContain("# 인물 Core: 서아");
    expect(p.system).toContain("20대 후반 여자 회사원");
    expect(p.user).toContain("- 너 (말): 팀장님 얘기는");
  });

  it("남자친구 윤재는 남자로 적힌다", () => {
    expect(coreFor("m")).toContain("20대 후반 남자 회사원");
    expect(coreFor("m")).toContain("# 인물 Core: 윤재");
  });

  it("이름과 성별 말고는 Core가 같다", () => {
    const strip = (t: string, name: string, g: string) => t.replaceAll(name, "X").replace(`${g} 회사원`, "Y 회사원");
    expect(strip(coreFor("m"), "윤재", "남자")).toBe(strip(coreFor("f"), "서아", "여자"));
    expect(sceneFactsFor("f").join()).toBe(sceneFactsFor("m").join().replaceAll("윤재", "서아"));
    expect(rubricFor("f")).not.toContain("윤재");
  });

  it("첫 화면 정보와 대본 모드도 이름을 따른다", () => {
    const sc = scenarioFor("f");
    expect(sc.npcName).toBe(PARTNERS.f.name);
    expect(sc.partnerLabel).toBe("여자친구");
    expect(JSON.stringify(sc.opening)).not.toContain("윤재");
    expect(JSON.stringify(scriptedReply(newGame("f2", Date.now(), false, "f"), "미안해").beats)).not.toContain("윤재");
  });

  it("엔딩 프롬프트도 고른 연인의 이름을 쓴다", () => {
    const s = recordTurn(newGame("f3", Date.now(), false, "f"), { player: "안녕", npc: [], suggested: 5, labels: ["emotion"] });
    const plan = planEnding(s);
    expect(plan.npcName).toBe("서아");
    const p = buildEndingPrompt(plan);
    expect(p.system + p.user).not.toContain("윤재");
  });

  it("예전 토큰(연인 정보 없음)은 윤재로 본다", () => {
    const old = { ...newGame("o", Date.now(), false) };
    delete (old as { partner?: string }).partner;
    expect(buildNpcPrompt(old, "안녕", "counter").system).toContain("# 인물 Core: 윤재");
  });
});
