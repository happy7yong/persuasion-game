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
    // consolidate@1: counter에서 뺀 "이미 공유한 사실 나열 금지"는 반복 금지 규칙이 그대로 맡는다
    expect(p.system).toContain("직전 네 대사에서 이미 설명한 사정·조건·결론을 같은 뜻의 다른 문장으로 다시 말하지 않는다");
    expect(p.system).toContain("해결책·약속·규칙을 제안하지 않는다");
    expect(p.system).toContain('thought의 "나"는 반드시 너 자신');
    expect(p.system).toContain("플레이어의 기대·서운함·요구를 네 1인칭 감정처럼 옮겨 쓰지 않는다");
    expect(p.system).toContain("Core와 현재 입장은 출발점이지");
    expect(p.system).toContain("플레이어의 말이 네 걱정이나 반론에 직접 답하고 일리가 있으면 실제로 설득될 수 있다");
    // consolidate@1: 지시어 금지 대신 "헷갈릴 때만 구체적으로, 누가 누구에게 한 일인지는 바뀌면 안 된다"
    expect(p.system).toContain("누가 누구에게 한 일인지 바뀌거나 빠져서 뜻이 달라지면 안 된다");
    expect(p.system).toContain("NPC인 너를 뜻한다"); // 발화 주체 규칙(엔진)은 그대로
    expect(p.system).toContain("## 표현의 구체성");
    // consolidate@1: 감정마다 이유를 풀어 쓰라는 줄과 그대로 베껴지던 예시 문장은 뺐다. 같은 감정 단어 반복 금지는 남긴다
    expect(p.system).toContain("같은 감정 단어로 매 턴 반응을 대신하지 않는다");
    expect(p.system).not.toContain("무엇 때문에 그런 감정이 생겼는지 구체적으로 말한다");
    expect(p.system).not.toContain("받아들이기 어렵다\"고 쓴다");
    expect(p.system).toContain("입장을 지킨다는 건 매번 그 입장을 말한다는 뜻이 아니다");
    expect(p.system).not.toContain("여덟 시간 기다린 건 걸리네");
    expect(p.system).toContain('플레이어의 "너/네가"는 NPC인 너를 뜻한다');
    expect(p.system).toContain('"X하겠다는 말", "그건 하겠다는 거네"');
    expect(p.system).toContain("이미 공유된 요구의 재확인에는 수락·거절·조건 조정·다음 행동 중 하나로 대화를 진행한다");
  });

  it("남자친구 윤재는 남자로 적힌다", () => {
    expect(coreFor("m")).toContain("20대 후반 남자 회사원");
    expect(coreFor("m")).toContain("# 인물 Core: 윤재");
    // consolidate@3: 성격·가치는 남기고 행동을 미리 정하던 문장은 뺐다 (게임 진행은 chooseMove·MOVE_GUIDE·BAND, 반복 방지는 공통 규칙이 맡는다)
    expect(coreFor("m")).toContain("그 결과는 자기 몫이라고 여긴다");
    expect(coreFor("m")).toContain("입장을 지키는 것과 그 입장을 말로 다시 꺼내는 것은 다르다");
    expect(coreFor("m")).toContain("지킬 수 없는 약속을 쉽게 하지 않는 것");
    for (const removed of ["행동의 기본 순서", "마지막 대화 전까지 유지", "먼저 짧게 사과한다", "해결책은 먼저 제안하지 않는다", "한 번의 짧은 연락을 말한 것이라면", "재연하지 않는다", "플레이 시 최우선 체크", "일부러 그런 건 아니잖아"]) {
      expect(coreFor("m")).not.toContain(removed);
    }
    expect(coreFor("m")).toContain("상대를 훈계하거나 심문하듯 몰아붙이지 않는다");
    // consolidate@1: 사과의 형식(명사·순서) 지시는 뺐고 사과의 의미는 남겼다
    expect(coreFor("m")).toContain("사과는 일부러 무시했다는 해석이나 앞으로 항상 연락하겠다는 약속에 동의하는 뜻이 아니다");
    expect(coreFor("m")).not.toContain("명사를 분명히");
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
