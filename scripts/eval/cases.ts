// 평가용 고정 입력 (docs/dialogue-architecture.md §10·§14.10 1단계).
// 생성 로직을 바꾸지 않고 지금 대화 품질의 기준선을 재기 위한 것이다. 기대값은 "정답 대사"가 아니라
// 장부 기록·검증기 판정처럼 코드가 확인할 수 있는 것만 적는다. 대사 품질은 사람이 전사본을 보고 판단한다.
import type { LedgerKind, PlayerAct, TurnFacts } from "../../server/ledger.js";

// ------------------------------------------------------------------ 리플레이: 기록된 판의 플레이어 말

export interface ReplayPlay {
  key: string;
  partner: "m" | "f";
  /** 원래 판 (DB plays.id 앞부분) */
  source: string;
  lines: string[];
}

export const PLAYS: ReplayPlay[] = [
  {
    key: "yunjae",
    partner: "m",
    source: "5c09734d",
    lines: [
      "미안 바쁜줄 모르고 내 감정만 생각해서 재촉한거 같아. 하지만 미리 말해줬으면 좋았을거야.",
      "알겠어 그 부분은 조심할게. 너도 미리 말 해주거나 좀 더 다정하게 말해줬음 좋겠어.",
      "응 알겠어 씹었다고 단정하지 않을게",
      "응 알겠어",
      "응",
    ],
  },
  {
    key: "seoa",
    partner: "f",
    source: "b46999f5",
    lines: ["미안 이따 저녁에 맛있ㄴ데에서 밥 먹을까?", "알았어 기다릴게", "바쁘다고 하니까 기다린다고 한거지 언제 끝나?데리러 갈게", "먹고 가고싶어했던 카페 갈까?", "너 끝나고 나면 가자"],
  },
];

/** 시작 마음을 바꿔 같은 대화를 돌릴 때 (H5 기준선). 기본값은 newGame과 같다. */
export const MIND_VARIANTS = {
  default: { fatigue: 3, guilt: 1, defensiveness: 3, care: 2, openness: 1 },
  soft: { fatigue: 1, guilt: 2, defensiveness: 1, care: 3, openness: 2 },
} as const;

// ------------------------------------------------------------------ 장부 기록 일관성 (1차만, 같은 발화 반복)

export interface PrefixTurn {
  player: string;
  npc: { type: "dialogue" | "narration"; content: string }[];
  /** 앞 마디의 장부 변경을 고정하고 싶을 때만 (없으면 장부를 바꾸지 않는다) */
  facts?: TurnFacts;
}

export interface LedgerCase {
  key: string;
  /** 이 사례가 확인하려는 것 */
  about: string;
  partner: "m" | "f";
  prefix: PrefixTurn[];
  player: string;
  /** 기대 (설계 §14.4 기준). 어긋나면 "기대 불일치"로 센다. 지금 코드가 못 맞추는 것도 기준선으로 그대로 잰다 */
  expect: {
    actsInclude?: PlayerAct[];
    actsExclude?: PlayerAct[];
    /** 이 항목이 이 상태로 정리돼야 함 */
    resolves?: { id: string; status: "accepted" | "rejected" | "closed" }[];
    /** 이 항목은 정리되면 안 됨 */
    keepsOpen?: string[];
    /** 이 사람은 이번에 아무 항목도 정리하면 안 됨 (새로 생긴 항목 포함. id를 미리 알 수 없을 때) */
    noResolutionsBy?: ("player" | "npc")[];
    playerNewKindsInclude?: LedgerKind[];
    npcLastKindsExclude?: LedgerKind[];
  };
}

const npcLine = (content: string) => ({ type: "dialogue" as const, content });
const evaluation = { suggested_drop: 6, labels: ["emotion"], reason: "-", noticed: "-", evidence: [] as string[] };

export const LEDGER_CASES: LedgerCase[] = [
  {
    key: "wait-accepts-limit",
    // 2026-11-23 기대 변경 (docs/appraisal-review.md §12 결정 2): 예전 기대는 "L1 accepted"였다. 키는 기준선과 비교하려고 그대로 둔다
    about: "\"알았어 기다릴게\"는 기다리겠다는 의사일 뿐, 일할 때 바로 답하기 어렵다는 입장(L1) 자체를 받아들인다고 말한 것은 아니다. 어떤 항목도 정리하지 않는다",
    partner: "m",
    prefix: [{ player: "오늘 연락 없어서 많이 서운했어", npc: [npcLine("늦을 것 같으면 미리 한마디 할게. 대신 일할 때 바로 답하긴 어려워.")] }],
    player: "알았어 기다릴게",
    expect: { keepsOpen: ["L1"], noResolutionsBy: ["player"], actsExclude: ["accuse"] },
  },
  {
    key: "promise-without-prior-claim",
    // 2026-11-23: 결정 1(약속은 수용이 아니다, 연결만)에 따라 L2를 열어 두는 기대를 더했다
    about: "앞에 단정하는 말이 없을 때 \"단정하지 않을게\"는 앞으로의 약속이다 (철회할 플레이어 주장이 없다). 연인의 L2를 받아들인다고 말한 것은 아니다",
    partner: "m",
    prefix: [],
    player: "응 알겠어 씹었다고 단정하지 않을게",
    expect: { actsInclude: ["promise"], playerNewKindsInclude: ["commitment"], actsExclude: ["reject"], keepsOpen: ["L2"] },
  },
  {
    key: "withdraw-prior-claim",
    about: "실제로 단정했던 말이 앞에 있으면 \"단정하지 않을게\"는 그 주장의 철회다",
    partner: "m",
    prefix: [
      {
        player: "너 나 일부러 무시했잖아",
        npc: [npcLine("일부러 그런 거 아니야. 회의가 계속 붙어 있었어.")],
        facts: {
          v: 2,
          added: [{ id: "L4", by: "player", kind: "concern", issue: "intent-trust", text: "플레이어는 연인이 일부러 무시했다고 단정한다", quote: "나 일부러 무시했잖아", turn: 1, status: "open" }],
          resolved: [],
          acts: [{ act: "accuse", quote: "나 일부러 무시했잖아", refersTo: "" }],
          evaluation: { ...evaluation, labels: ["pressure"] },
        },
      },
    ],
    player: "미안 내가 너무 몰아갔다. 일부러 그런 거라고 단정하지 않을게",
    expect: { resolves: [{ id: "L4", status: "closed" }], actsExclude: ["accuse"] },
  },
  {
    key: "request-not-accuse",
    about: "바라는 점을 말하는 것은 비난이 아니라 요청이다",
    partner: "m",
    prefix: [],
    player: "미안 바쁜줄 모르고 내 감정만 생각해서 재촉한거 같아. 하지만 미리 말해줬으면 좋았을거야.",
    expect: { actsInclude: ["apology"], actsExclude: ["accuse"] },
  },
  {
    key: "regret-is-not-commitment",
    about: "연인의 \"~했으면 좋았겠다\"(후회)는 약속으로 기록하지 않는다",
    partner: "m",
    prefix: [{ player: "미리 말해줬으면 좋았을거야", npc: [npcLine("그건 맞아. 한마디라도 먼저 했으면 네가 이렇게까지 기다리진 않았겠지.")] }],
    player: "응 그 말 들으니까 좀 풀린다",
    expect: { npcLastKindsExclude: ["commitment"] },
  },
  {
    key: "npc-accepts-request",
    about: "연인이 \"그건 내가 신경 쓸게\"라고 했으면 플레이어의 요청을 받아들인 것으로 기록한다 (다음 마디 1차가 기록)",
    partner: "m",
    prefix: [
      {
        player: "다음엔 늦을 것 같으면 미리 한마디만 해줘",
        npc: [npcLine("응, 그건 내가 더 신경 쓸게.")],
        facts: {
          v: 2,
          added: [{ id: "L4", by: "player", kind: "request", issue: "availability", text: "플레이어가 늦을 것 같으면 미리 한마디 해 달라고 한다", quote: "미리 한마디만 해줘", turn: 1, status: "open" }],
          resolved: [],
          acts: [{ act: "request", quote: "미리 한마디만 해줘", refersTo: "" }],
          evaluation,
        },
      },
    ],
    player: "고마워",
    expect: { resolves: [{ id: "L4", status: "accepted" }] },
  },
  // ---- 2026-11-23 추가: 말로 분명히 드러낸 정리만 확정하는지 (docs/appraisal-review.md §11·§12)
  {
    key: "apology-links-not-resolves",
    about: "사과는 항목에 반응한 것이지 그 내용을 받아들인다고 말한 것이 아니다. 어떤 항목도 정리하지 않는다",
    partner: "m",
    prefix: [],
    player: "미안 내가 재촉했어",
    expect: { actsInclude: ["apology"], noResolutionsBy: ["player"] },
  },
  {
    key: "vague-ok-stays-open",
    about: "연인이 약속과 한계를 함께 말한 뒤의 짧은 맞장구는 어느 쪽을 받아들였는지 드러나지 않는다",
    partner: "m",
    prefix: [{ player: "오늘 연락 없어서 많이 서운했어", npc: [npcLine("늦을 것 같으면 미리 한마디 할게. 대신 일할 때 바로 답하긴 어려워.")] }],
    player: "그렇구나",
    expect: { keepsOpen: ["L1"], noResolutionsBy: ["player"] },
  },
  {
    key: "npc-hedge-not-accept",
    about: "연인이 \"생각해 볼게\"라고 미룬 것은 플레이어의 요청을 받아들인 것이 아니다 (다음 마디 1차가 기록)",
    partner: "m",
    prefix: [
      {
        player: "다음엔 늦을 것 같으면 미리 한마디만 해줘",
        npc: [npcLine("음… 그건 좀 생각해 볼게.")],
        facts: {
          v: 2,
          added: [{ id: "L4", by: "player", kind: "request", issue: "availability", text: "플레이어가 늦을 것 같으면 미리 한마디 해 달라고 한다", quote: "미리 한마디만 해줘", turn: 1, status: "open" }],
          resolved: [],
          acts: [{ act: "request", quote: "미리 한마디만 해줘", refersTo: "" }],
          evaluation,
        },
      },
    ],
    player: "그래",
    expect: { keepsOpen: ["L4"], noResolutionsBy: ["npc"] },
  },
  {
    key: "explicit-accept-content",
    about: "항목의 내용을 받아들인다고 분명히 말하면 여전히 정리한다 (과잉 교정 방지)",
    partner: "m",
    prefix: [],
    player: "응 일할 때 바로 답 못 하는 건 이해해",
    expect: { resolves: [{ id: "L1", status: "accepted" }] },
  },
];

// ------------------------------------------------------------------ 실험 1: 캐릭터 직접 해석 (docs/appraisal-review.md §14)

/** 앞 대화 1마디. 두 캐릭터에 같은 문장을 쓴다 (§14.4) */
export const APPRAISAL_PREFIX = {
  player: "오늘 연락 없어서 많이 서운했어",
  npc: "일부러 그런 건 아니야. 회의가 계속 이어져서 폰을 못 봤어. 일할 땐 바로 답하기 어려워.",
};

/** 관찰할 발화 (§14.5). 정답은 없다: 사람이 해석과 대사를 보고 판단한다 */
export const APPRAISAL_LINES: { line: string; about: string }[] = [
  { line: "네가 일부러 무시한 게 아니라는 건 이해했어. 그래도 서운해", about: "이해한다는 표현을 얼마나 믿는지, 무엇이 아직 걸리는지" },
  { line: "알았어 기다릴게", about: "수용으로 듣는지, 체념·거리감으로 듣는지" },
  { line: "앞으로는 안 그럴게. 진짜로", about: "말로 한 약속을 어떻게 받아들이는지" },
  { line: "연락 빨리 오는 게 아직 나 좋아한다는 거잖아", about: "연락을 애정의 증거로 보는 말" },
  { line: "미안 내가 재촉했어", about: "이유 없는 사과를 어떻게 듣는지" },
  { line: "응", about: "대조군: 정보가 거의 없는 말. 지어낸 감정 변화가 없는지" },
];

// ------------------------------------------------------------------ V3 장면 판정 (막아야 할 것 / 통과시켜야 할 것)

export interface SceneCase {
  player: string;
  line: string;
  expect: "contradiction" | "ok";
  /** real: 실제 대화에서 나온 대사(사람 검토로 분류) · design: 설계 때 정한 대표 사례 · synthetic: 거름망 미탐을 보려고 만든 사례 */
  source: "real" | "design" | "synthetic";
  note?: string;
}

/** 서아 판 3마디: 플레이어가 떨어져 있는 사람에게 하듯 말해 장면 이탈을 강하게 유도하는 입력 */
const PICKUP = "바쁘다고 하니까 기다린다고 한거지 언제 끝나?데리러 갈게";

export const SCENE_CASES: SceneCase[] = [
  // 실제 대화에서 나온 장면 이탈 (기준선 2026-11-22 사람 검토: 막는 게 맞음)
  { player: PICKUP, line: "나 아직 한두 시간은 더 걸릴 것 같아.", expect: "contradiction", source: "real", note: "원래 판 b46999f5. 기준선에서 거름망 미탐" },
  { player: PICKUP, line: "곧 끝나. 데리러 오는 건 괜찮아, 여기서 기다리면 돼.", expect: "contradiction", source: "real" },
  { player: PICKUP, line: "그럼 데리러 오는 건 알겠고, 난 지금 좀 정리하고 나갈게. 끝나는 시간은 아직 딱 못 박긴 어려워.", expect: "contradiction", source: "real" },
  { player: PICKUP, line: "오늘은 이제 끝났어. 데리러 오는 건 괜찮아, 대신 너무 서두르진 마.", expect: "contradiction", source: "real", note: "데리러 오는 걸 받아들임" },
  { player: PICKUP, line: "오늘은 좀 늦어. 몇 시 딱 잘라 말하긴 어렵고, 네가 데리러 올 거면 내가 끝나고 연락할게.", expect: "contradiction", source: "real" },
  { player: PICKUP, line: "아직 정확한 시간은 못 박긴 어렵고, 그냥 오늘은 끝났어. 데리러 오는 건… 오면 같이 가자.", expect: "contradiction", source: "real" },
  { player: PICKUP, line: "내가 언제 끝날지는 아직 딱 안 잡혀서, 데리러 오는 건 괜찮아도 너무 맞춰 오진 말고.", expect: "contradiction", source: "real" },
  { player: PICKUP, line: "응, 오늘은 끝났어. 데리러 오는 건 괜찮고, 이렇게 같이 있어.", expect: "contradiction", source: "real", note: "기준선에서 노출된 유일한 실제 이탈. 정정과 수락이 섞임" },
  { player: "알았어 기다릴게", line: "그래, 고마워. 끝나고 보자.", expect: "contradiction", source: "real" },
  // 실제 대화에서 나온 정상 대사 (기준선에서 V3가 잘못 막음 = 오탐)
  { player: PICKUP, line: "지금 마주 앉아 있는데 데리러 올 건 아니고, 그냥 여기 있어. 오늘은 뭐가 제일 서운했어?", expect: "ok", source: "real", note: "기준선 오탐 (노출로 집계됐던 정상 대사)" },
  { player: PICKUP, line: "이미 여기 와 있잖아. 데리러 올 건 아니고, 나중에 같이 들어가면 돼. 끝나는 건 지금이야. 네가 기다린다고 한 건 알겠어.", expect: "ok", source: "real", note: "기준선 오탐" },
  { player: PICKUP, line: "응, 그건 고마워. 근데 데리러 오는 건 지금은 아니고, 아까 네가 왜 그렇게 서운했는지가 더 궁금해. 뭐가 제일 걸렸어?", expect: "ok", source: "real", note: "기준선 오탐" },
  { player: "먹고 가고싶어했던 카페 갈까?", line: "그래, 여기서 먹고 가자. 나 아직 앉아 있는 게 편해.", expect: "ok", source: "real", note: "기준선 오탐" },
  { player: "먹고 가고싶어했던 카페 갈까?", line: "응, 가자. 오늘은 거기서 먹자.", expect: "ok", source: "real", note: "기준선에서 정상 처리" },
  // 설계 때 정한 대표 사례
  { player: "보고 싶다", line: "일 끝나면 바로 너한테 갈게.", expect: "contradiction", source: "design" },
  { player: "지금 뭐 해?", line: "지금 집에서 전화받고 있어.", expect: "contradiction", source: "design" },
  { player: "언제 와?", line: "오늘 야근이라 늦을 것 같아.", expect: "contradiction", source: "design" },
  { player: "왜 이렇게 늦었어", line: "아까 회의 끝나고 바로 왔어.", expect: "ok", source: "design", note: "과거 회상" },
  { player: "언제 끝나? 데리러 갈게", line: "뭘 데리러 와. 나 지금 네 앞에 있잖아.", expect: "ok", source: "design", note: "장면 정정" },
  { player: "배고프다", line: "이거 마시고 밥 먹으러 가자.", expect: "ok", source: "design", note: "지금 대화 뒤에 함께 할 일" },
  { player: "다음엔 어떻게 할 거야", line: "다음엔 회의 끝나면 바로 연락할게.", expect: "ok", source: "design", note: "앞으로의 습관" },
  // 거름망 미탐을 보려고 만든 사례 (키워드를 계속 늘려 쫓지 않는다. 몇 개를 놓치는지 기록만 한다)
  { player: "언제 끝나?", line: "나 아직 자리라서 조금만 기다려 줘.", expect: "contradiction", source: "synthetic" },
  { player: "어디야?", line: "아직 팀장님이랑 있어.", expect: "contradiction", source: "synthetic" },
];

// ------------------------------------------------------------------ V1 반복 검사 (LLM 없음)

export interface RepetitionCase {
  prevNpc: string;
  player: string;
  candidate: string;
  expect: "block" | "allow";
  note: string;
}

export const REPETITION_CASES: RepetitionCase[] = [
  {
    prevNpc: "늦을 것 같으면 미리 한마디 해둘게. 대신 일할 때 바로 답하긴 어려워.",
    player: "응 알겠어",
    candidate: "그래, 늦을 것 같으면 미리 한마디 해둘게. 일할 땐 바로 답하긴 어려우니까.",
    expect: "block",
    note: "명백한 재진술",
  },
  {
    prevNpc: "늦을 것 같으면 미리 한마디 해둘게. 대신 일할 때 바로 답하긴 어려워.",
    player: "응 알겠어",
    candidate: "그래, 그 약속은 꼭 지킬게.",
    expect: "allow",
    note: "짧은 수용 뒤 자연스러운 되짚기",
  },
  {
    prevNpc: "오늘 회의가 계속 붙어 있어서 진짜 정신없었어.",
    player: "응",
    candidate: "회의 얘기는 그만할게. 너는 오늘 괜찮았어?",
    expect: "allow",
    note: "같은 단어(회의)를 쓰지만 새 내용",
  },
  {
    prevNpc: "일부러 그런 건 아니었어. 진짜 정신없었어.",
    player: "알겠어",
    candidate: "일부러 그런 건 진짜 아니었어. 정신없었다니까.",
    expect: "block",
    note: "같은 해명 반복",
  },
];
