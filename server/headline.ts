// 은하 신문 1면: 대화가 끝난 뒤, 사실 이 대화가 은하연애위원회에 생중계되고 있었다는 반전과 함께
// "가장 많이 움직인 말"이 3026년 은하 신문 1면을 장식한다. 리포트를 먼저 보여 주고 뒤에서 만든다.
// 예전 은하 엔딩(58139db에서 제거)에서 헤드라인만 살렸다. 헷갈린다는 피드백을 받은 연도 연표는 쓰지 않는다.
// - 1면에 실을 말(quote)은 엔진이 고른다 (가장 많이 움직인 마디의 실제 말). LLM은 기사만 쓴다.
import { z } from "zod";
import { PARTNERS } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { shakePercent, type GameState, type Outcome } from "./rules.js";

export const HEADLINE_PROMPT_VERSION = "galaxy-headline@1";

export interface Headline {
  kind: "headline";
  v: 1;
  /** 1면 제목: 그 말이 은하에 남긴 결과 */
  title: string;
  /** 한 줄 부연 */
  subtitle: string;
  /** 1면에 실린 플레이어의 실제 말 */
  quote: string;
  /** 몇 번째 말인지 (1부터) */
  quoteTurn: number;
  /** 은하 역사 교과서 1장 첫 문장 */
  textbook: string;
  sideArticles: string[];
  model: string;
  usage: LlmUsage | null;
}

const OUTCOME_KO: Record<Outcome, string> = {
  success: "설득 성공 (연인의 마음을 돌렸다)",
  compromise: "타협 (꽤 흔들었지만 완전히 넘어오진 않았다)",
  breakdown: "결렬 (거의 안 움직였다)",
  giveup: "포기 (지구인이 대화를 중간에 멈췄다)",
};

/** 1면에 실을 말: 가장 많이 움직인 마디. 같으면 나중 마디 (마지막 한마디가 더 극적이다). */
export function pickHeadlineTurn(state: GameState): number | null {
  let best: number | null = null;
  state.turns.forEach((t, i) => {
    if (best === null || t.applied >= state.turns[best - 1]!.applied) best = i + 1;
  });
  return best;
}

const Raw = z.object({
  title: z.string().trim().min(1).max(60),
  subtitle: z.string().trim().min(1).max(100),
  textbook: z.string().trim().min(1).max(160),
  side_articles: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
});

const STR = { type: "string" } as const;
export const HEADLINE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "textbook", "side_articles"],
  properties: { title: STR, subtitle: STR, textbook: STR, side_articles: { type: "array", items: STR } },
} as const;

/** 실존 인물·기업·정치·종교, 죽음·폭력 같은 소재는 1면에 싣지 않는다. */
const BANNED = /대통령|국회의원|삼성|애플|구글|카카오|네이버|트럼프|윤석열|이재명|교회|불교|이슬람|사망|숨졌|살해|자살|폭탄|전쟁|테러/;

/** strict: 교과서 문장 형식까지 맞아야 한다. 마지막 시도(strict=false)는 형식만 본다. */
export function parseHeadline(json: unknown, strict: boolean): Pick<Headline, "title" | "subtitle" | "textbook" | "sideArticles"> {
  const raw = Raw.parse(json);
  const all = [raw.title, raw.subtitle, raw.textbook, ...raw.side_articles].join("\n");
  if (BANNED.test(all)) throw new Error("headline_banned_topic");
  if (strict && !/^모든 것은/.test(raw.textbook)) throw new Error("headline_textbook_format");
  return { title: raw.title, subtitle: raw.subtitle, textbook: raw.textbook, sideArticles: raw.side_articles.slice(0, 2) };
}

export function buildHeadlinePrompt(state: GameState, quoteTurn: number): { system: string; user: string } {
  const name = PARTNERS[state.partner ?? "m"].name;
  const system = `너는 '은하 연합 타임스'의 속보 작가다. 한 지구인이 카페에서 연인 ${name}와 연락 문제로 나눈 다섯 마디 대화가, 사실은 은하연애위원회에 생중계되고 있었다.
그 대화에서 가장 결정적이었던 한마디가 1,000년 뒤 은하를 어떻게 바꿔 놓았는지, 3026년 은하 신문 1면을 쓴다.

# 톤
- 사소한 말이 터무니없이 거대한 결과로 번지는 과장된 코미디. 동네에서 시작해 은하까지 커진다.
- 숫자를 크고 구체적으로: 커플 수(만 쌍~억 쌍), 행성 수, 은하크레딧, %. 법·공휴일·은하 의회·외계 종족이 등장해도 좋다.
- 그 말의 실제 단어와 내용이 결과의 원인이어야 한다. 그 말을 비웃지 않고, 그 말이 세상을 바꿔 버린 것을 웃기게 쓴다.
- 욕설이나 비속어가 있으면 그 단어를 다시 쓰지 말고 "그 한마디" 등으로 돌려 말한다.
- 대화 결과와 어긋나지 않게: 결렬이면 "끝내 마음을 돌리지 못한 그 한마디"가 남긴 웃픈 결과로.
- 금지: 실존 인물·기업·정치·종교, 죽음·폭력·재난 피해, 외모·몸 비하, 성적 내용.
- 한국어, 짧고 리듬감 있게. 신문 문체("~다").

# 톤 예시 (그대로 베끼지 말 것)
말: "바쁘면 미리 말만 해줘"
title: 지구인의 "미리 말만 해줘", 은하 공용 인사말 1,000주년
subtitle: 외계 문명 첫 교신도 "혹시 바쁘시면 미리 말씀해 주시겠어요?"였다
side_articles: ["오전 9시 59분, 은하 메신저 서버 또 폭주", "'회의 들어감' 이모티콘, 12개 행성 국민 이모티콘 선정"]

# 출력: JSON 하나
{"title":"...","subtitle":"...","textbook":"...","side_articles":["...","..."]}
- title: 1면 제목. 그 결정적인 한마디가 은하에 남긴 결과. 40자 이내.
- subtitle: 한 줄 부연. 60자 이내.
- textbook: 은하 역사 교과서 1장 첫 문장. "모든 것은 한 지구인이 카페에서 ~라고 한 데서 시작되었다." 형식. 말은 짧게 줄여도 된다.
- side_articles: 같은 지면의 짧은 기사 제목 2개. 각 40자 이내.`;

  const lines = state.turns
    .map((t, i) => `${i + 1}. "${t.player}" → 마음 +${t.applied}%${i + 1 === quoteTurn ? "  ← 1면에 실릴 결정적인 한마디" : ""}`)
    .join("\n");
  const user = `# 대화 결과
${name}의 마음은 ${shakePercent(state.score)}% 움직였다. 결과: ${OUTCOME_KO[state.outcome ?? "breakdown"]}

# 지구인이 한 말 (차례대로)
${lines}

1면에 실릴 결정적인 한마디: "${state.turns[quoteTurn - 1]!.player}"
위 내용으로 JSON을 쓴다.`;
  return { system, user };
}

export type HeadlineResult = { ok: true; headline: Headline; attempts: AttemptRecord[] } | { ok: false; failure: LlmFailure | null; attempts: AttemptRecord[] };

export async function writeHeadline(state: GameState): Promise<HeadlineResult> {
  const quoteTurn = pickHeadlineTurn(state);
  if (quoteTurn === null) return { ok: false, failure: null, attempts: [] };
  const quote = state.turns[quoteTurn - 1]!.player;
  if (isScripted()) return { ok: true, headline: scriptedHeadline(quote, quoteTurn), attempts: [] };
  const cfg = modelConfig("headline");
  const prompt = buildHeadlinePrompt(state, quoteTurn);
  const res = await callWithRetry(cfg, { ...prompt, schemaName: "headline", schema: HEADLINE_JSON_SCHEMA }, (json, a) => parseHeadline(json, !a.last));
  if (!res.ok) return res;
  const last = res.attempts.at(-1);
  return {
    ok: true,
    headline: { kind: "headline", v: 1, ...res.value, quote, quoteTurn, model: last?.respondedModel ?? cfg.model, usage: last?.usage ?? null },
    attempts: res.attempts,
  };
}

/** 대본 모드: 키 없이 화면 형식만 보여 준다. */
function scriptedHeadline(quote: string, quoteTurn: number): Headline {
  const short = Array.from(quote).slice(0, 20).join("").trim();
  return {
    kind: "headline",
    v: 1,
    title: "지구인의 그 한마디, 은하 연애 헌법 제1조로",
    subtitle: "은하연애위원회 \"그 카페의 라떼가 역사를 바꿨다\"",
    quote,
    quoteTurn,
    textbook: `모든 것은 한 지구인이 카페에서 "${short}"라고 한 데서 시작되었다.`,
    sideArticles: ["은하 외식 연합, 그 카페에 1,000년째 감사패 발송 중", "장거리 연애 행성 시리우스, 관광객 폭증"],
    model: "scripted",
    usage: null,
  };
}
