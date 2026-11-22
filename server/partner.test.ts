// 연인별 Core와 공통 장면을 검증한다.
import { describe, expect, it } from "vitest";
import { coreFor, PARTNERS, rubricFor, scenarioFor, sceneFactsFor } from "./content.js";
import { buildReport } from "./report.js";
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

  it("서아는 투박해도 문장이 어긋나거나 이미 말한 사정을 반복하지 않는다", () => {
    const p = buildNpcPrompt(newGame("f-context", Date.now(), false, "f"), "안녕", "counter");
    expect(p.system).toContain("투박함은 뜻이 흐리거나 어색한 문장이 아니다");
    expect(p.system).toContain("이미 말한 회의·폰·샌드위치 설명을 덧붙여 자리를 채우고 있지는 않은가");
    expect(p.system).toContain("이미 공유한 사실을 다시 나열하지 않고");
    expect(p.system).toContain("해결책·약속·규칙을 제안하지 않는다");
    expect(p.system).toContain('thought의 "나"는 반드시 너 자신');
    expect(p.system).toContain("플레이어의 기대·서운함·요구를 네 1인칭 감정처럼 옮겨 쓰지 않는다");
    expect(p.system).toContain("Core와 현재 입장은 출발점이지");
    expect(p.system).toContain("플레이어의 말이 네 걱정이나 반론에 직접 답하고 일리가 있으면 실제로 설득될 수 있다");
    expect(p.system).toContain('"그 말", "그 정도", "그렇게까지"로 뭉개지 않는다');
    expect(p.system).toContain('"걸린다", "마음에 남는다", "좀 그렇다", "억울하다"');
    expect(p.system).toContain("## 표현의 구체성");
    expect(p.system).not.toContain("여덟 시간 기다린 건 걸리네");
    expect(p.system).toContain('"나한테 일부러 그런 것처럼 말한"');
    expect(p.system).toContain('"내가 일부러 너를 무시한 것처럼 말한 건 받아들이기 어렵다"');
    expect(p.system).toContain('플레이어의 "너/네가"는 NPC인 너를 뜻한다');
    expect(p.system).toContain('"X하겠다는 말", "그건 하겠다는 거네"');
    expect(p.system).toContain("이미 공유된 요구의 재확인에는 수락·거절·조건 조정·다음 행동 중 하나로 대화를 진행한다");
  });

  it("남자친구 윤재는 남자로 적힌다", () => {
    expect(coreFor("m")).toContain("20대 후반 남자 회사원");
    expect(coreFor("m")).toContain("# 인물 Core: 윤재");
    expect(coreFor("m")).toContain("같은 하루를 더 자세히 재연하지 않는다");
    expect(coreFor("m")).toContain("한 번의 짧은 연락을 말한 것이라면");
    expect(coreFor("m")).toContain("그 결과에는 먼저 짧게 사과한다");
    expect(coreFor("m")).toContain("상대를 훈계하거나 심문하듯 몰아붙이지 않는다");
    expect(coreFor("m")).toContain("사과할 때는 무엇을 사과하는지 명사를 분명히 말하고");
    expect(coreFor("m")).toContain("플레이어가 팀장에게 혼난 일은 진심으로 걱정하고 있다");
    expect(coreFor("m")).toContain("억울하고 서운하다");
    expect(coreFor("m")).toContain("윤재가 원하는 것과 화가 나는 조건");
    expect(coreFor("m")).toContain("설명을 전부 변명으로만 치부하면 윤재도 화가 난다");
    expect(coreFor("m")).toContain("플레이어 말을 \"그 정도면\", \"알아듣겠어\"");
  });

  it("윤재 전용 서술은 서아에게 전달되지 않고 장면은 공유한다", () => {
    expect(coreFor("m")).toContain("밀린 이야기를 천천히");
    expect(coreFor("f")).not.toContain("밀린 이야기를 천천히");
    expect(sceneFactsFor("f").join()).toBe(sceneFactsFor("m").join().replaceAll("윤재", "서아"));
    expect(sceneFactsFor("m").join()).toContain("15:10의 '바빠?'만 15:32에 읽었다");
    expect(sceneFactsFor("f").join()).toContain("답장을 미뤘다");
    expect(rubricFor("f")).not.toContain("윤재");
  });

  it("첫 화면 정보와 대본 모드도 이름을 따른다", () => {
    const sc = scenarioFor("f");
    expect(sc.npcName).toBe(PARTNERS.f.name);
    expect(sc.partnerLabel).toBe("여자친구");
    expect(JSON.stringify(sc.opening)).not.toContain("윤재");
    expect(sc.kakao.filter((m) => m.from === "me" && m.readAt).map((m) => m.readAt)).toEqual(["15:32"]);
    expect(JSON.stringify(scriptedReply(newGame("f2", Date.now(), false, "f"), "미안해").beats)).not.toContain("윤재");
  });

  it("리포트도 고른 연인의 이름을 쓴다", () => {
    const s = recordTurn(newGame("f3", Date.now(), false, "f"), { player: "안녕", npc: [], suggested: 5, labels: ["emotion"] });
    expect(buildReport(s).npcName).toBe("서아");
  });

  it("예전 토큰(연인 정보 없음)은 윤재로 본다", () => {
    const old = { ...newGame("o", Date.now(), false) };
    delete (old as { partner?: string }).partner;
    expect(buildNpcPrompt(old, "안녕", "counter").system).toContain("# 인물 Core: 윤재");
  });
});
