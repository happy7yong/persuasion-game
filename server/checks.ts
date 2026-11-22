// 대사 검증기 (docs/dialogue-architecture.md §9). 대사가 나온 뒤, 화면에 보내기 전에 코드가 확인한다.
// - V2 재주장: 이미 정리된(받아들여짐·거둬들임) 장부 항목을 다시 내세우는지. 대사 모델의 자기 보고(refs)로 판단한다.
// - V3 장면 이탈: 카페에 마주 앉아 있다는 장면과 모순되는지. 키워드는 거름망일 뿐이고, 걸린 대사만 작은 판정 호출로 결정한다.
// 정책 (2026-11-22 합의): 첫 시도에서만 거부하고 이유를 붙여 다시 생성한다. 마지막 시도는 통과시키되 "노출"로 기록한다.
// 이상한 대사 하나보다 대화가 끊기는 쪽이 더 나쁘기 때문이다.
import { z } from "zod";
import type { LedgerItem } from "./ledger.js";

// ------------------------------------------------------------------ V2 재주장

export const REF_USES = ["assert", "acknowledge", "reference"] as const;
export type RefUse = (typeof REF_USES)[number];
export interface Ref {
  id: string;
  /** assert: 그 주장을 다시 내세움 · acknowledge: 받아들여진 것을 인정·고마워함 · reference: 지나가듯 언급 */
  use: RefUse;
}

/** 정리된 항목을 다시 "주장"하면 위반. 인정·언급은 허용한다 (감사·회상까지 막지 않게). */
export function reassertViolation(ledger: readonly LedgerItem[], refs: readonly Ref[]): string | null {
  const hit = refs.filter((r) => r.use === "assert").map((r) => ledger.find((x) => x.id === r.id)).filter((x): x is LedgerItem => Boolean(x && x.by === "npc" && (x.status === "accepted" || x.status === "closed")));
  return hit.length ? `reasserts_resolved:${hit.map((x) => x.id).join(",")}` : null;
}

// ------------------------------------------------------------------ V3 장면 이탈

/**
 * 장면(카페에 마주 앉음, 오늘 일은 끝남)과 어긋날 수 있는 표현. 판정 호출을 부를지 정하는 거름망이다.
 * 회상("아까 회의 끝나고 왔어")·정정("나 지금 네 앞에 있잖아")도 걸리지만, 판정 호출이 정상으로 돌려준다.
 * key는 어떤 표현이 판정을 얼마나 부르는지 세는 데 쓴다.
 */
export const SCENE_TRIGGERS: readonly { key: string; re: RegExp }[] = [
  { key: "끝나면", re: /끝나(면|고\s*나면)/ },
  { key: "끝나고", re: /끝나고/ },
  { key: "데리러", re: /데리러/ },
  { key: "이따", re: /이따/ },
  { key: "나중에 만남", re: /나중에\s*(만나|보자|봐|얘기)/ },
  { key: "가자·갈게·와줘", re: /(가자|갈게|갈래|올래|와\s*줘|와줄래|오면\s*돼)/ },
  { key: "연락 수단", re: /(전화|통화|문자|카톡)\s*(로|해|할게|하자|받|중)/ },
  { key: "다른 장소", re: /(집에|집이야|회사|사무실|퇴근)/ },
  { key: "아직 일하는 중", re: /(아직\s*(일|회의|야근)|일하는\s*중|회의\s*중|야근)/ },
  { key: "이동", re: /(도착|출발|가는\s*중|가고\s*있)/ },
];

export function sceneTriggers(text: string): string[] {
  return SCENE_TRIGGERS.filter((t) => t.re.test(text)).map((t) => t.key);
}

export type SceneVerdict = "contradiction" | "ok" | "unclear";
const SceneSchema = z.object({ verdict: z.enum(["contradiction", "ok", "unclear"]), reason: z.string().trim().max(120) });
export const SCENE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["contradiction", "ok", "unclear"] }, reason: { type: "string" } },
} as const;
export const parseSceneVerdict = (json: unknown) => SceneSchema.parse(json);

/** 판정 프롬프트. 장면 사실과 방금 오간 두 말만 준다. */
export function buildSceneCheckPrompt(sceneFacts: readonly string[], npcName: string, playerText: string, npcDialogue: string): { system: string; user: string } {
  return {
    system: `너는 장면 감독이다. ${npcName}의 대사가 지금 장면의 사실과 모순되는지만 판정한다. 대사의 품질이나 말투는 보지 않는다.

# 지금 장면 (바뀌지 않는다)
- 지금 ${npcName}와 플레이어는 금요일 밤 동네 카페에 **마주 앉아 있다**. ${npcName}의 오늘 일은 이미 끝났다.
${sceneFacts.map((f) => `- ${f}`).join("\n")}

# 판정
- contradiction: 대사가 지금 두 사람이 따로 있거나 ${npcName}가 아직 일하는 중인 것처럼 현재·미래 상황을 말한다. 예: "나 아직 한두 시간 더 걸려", "끝나면 바로 갈게", "지금 집에서 전화받고 있어", "데리러 와".
- ok: 과거 회상("아까 회의 끝나고 바로 왔어"), 장면을 바로잡음("뭘 데리러 와, 나 지금 네 앞에 있잖아"), 지금 대화 뒤에 함께 할 일("이거 마시고 밥 먹으러 가자"), 앞으로의 습관("다음엔 회의 끝나면 바로 연락할게").
- unclear: 위 둘 중 어느 쪽인지 판단하기 어렵다.

JSON {"verdict":"...","reason":"40자 이내"}로만 답한다.`,
    user: `# 방금 플레이어의 말\n${playerText}\n\n# ${npcName}의 대사\n${npcDialogue}`,
  };
}

// ------------------------------------------------------------------ 결과 기록

export interface AttemptCheck {
  attempt: number;
  last: boolean;
  /** 이 시도에서 걸린 위반 (V1 반복 · V2 재주장 · V3 장면 · V4 끝맺음) */
  violations: string[];
  /** V3 거름망에 걸린 표현 */
  sceneTriggers: string[];
  /** V3 판정 결과 (거름망에 걸렸을 때만) */
  sceneVerdict?: { verdict: SceneVerdict; reason: string };
  refs: Ref[];
}

/**
 * 한 마디의 검증 결과.
 * - clean: 첫 시도에 위반 없음
 * - prevented: 첫 시도가 거부됐고, 다시 만든 대사는 위반 없음 (검증기가 문제를 막음)
 * - exposed: 마지막으로 보여 준 대사에도 위반이 있음 (사용자에게 노출된 결함. 통과로 세지 않는다)
 * 오탐(정상 대사를 거부)은 코드가 알 수 없어 거부된 원문을 사람이 본다 (llm_calls.response_text).
 */
export type CheckOutcome = "clean" | "prevented" | "exposed";
export function checkOutcome(checks: readonly AttemptCheck[]): CheckOutcome {
  const final = checks.at(-1);
  if (!final || final.violations.length === 0) return checks.length <= 1 ? "clean" : "prevented";
  return "exposed";
}
