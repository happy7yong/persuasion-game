// 경험 실험 (docs/appraisal-review.md §16)의 결과 정리. LLM을 부르지 않는 순수 함수만 둔다.
// 실험 1(appraisal.ts)의 섞기·대사 정리·위반 분류를 그대로 쓴다.
// - 가린 비교표: 조건과 속마음 필드를 숨기고 최종 대사만 섞는다. 읽는 사람이 대사만 보고 어느 경험인지 맞힐 수 있는가
// - 해석 검토표: 조건별로 heard·focus·belief·standard·want와 대사를 나란히
// - 요약: 조건별 과거 언급 비율(대사 / 속마음), 거부 사유, 질문 끝맺음, shift 분포

import { beatsText, mulberry32, shuffled, violationKind, type Beat, type Draft } from "./appraisal.js";
import type { ExperienceCond } from "./cases.js";

export interface ExpGen {
  cond: ExperienceCond;
  run: number;
  ok: boolean;
  failure?: string;
  drafts: Draft[];
  final?: Beat[];
  outcome?: string;
  endsWithQuestion?: boolean;
  heard?: string;
  focus?: string;
  belief?: string;
  standard?: string[];
  shift?: { axis: string; delta: number; why: string }[];
  want?: string;
}
export interface ExpCell {
  key: "same" | "transfer";
  line: string;
  about: string;
  /** 1차가 기록한 것 (세 조건이 같이 쓴다) */
  factsSummary?: string;
  factsFailure?: string;
  gens: ExpGen[];
}

export const COND_LABEL: Record<ExperienceCond, string> = { A: "A 약속을 어긴 경험", B: "B 약속을 지킨 경험", C: "C 경험 정보 없음" };
const CONDS: ExperienceCond[] = ["A", "B", "C"];

/**
 * 이전 경험을 겉으로 언급했는가 (거친 표시). 판정이 아니라 사람이 볼 곳을 고르는 용도다.
 * "또"는 "또 그 말"처럼 반복을 짚을 때가 많아 넣었지만 다른 뜻으로도 쓰여 오탐이 있을 수 있다.
 */
export const PAST_REF = /저번|지난번|지난달|한 달|그때|그 주|전에도|예전|또다시|또 |매번|이번에도/;
export const mentionsPast = (text: string | undefined) => !!text && PAST_REF.test(text);

const dialogueOf = (beats: readonly Beat[] | undefined) => (beats ?? []).filter((b) => b.type === "dialogue").map((b) => b.content).join(" ");
const innerOf = (g: ExpGen) => [g.heard, g.focus, g.belief, ...(g.standard ?? []), g.want].filter(Boolean).join(" ");

/**
 * 가린 비교표. 같은 발화 안에서 세 조건의 최종 대사를 섞고, 전체에 1부터 번호를 붙인다.
 * 조건 배정·속마음 필드·검증 결과·과거 언급 표시는 넣지 않는다. 조건이 무엇인지(A·B·C의 뜻)만 알려 준다.
 * key: "7" → { line: "same", cond, run }
 */
export function blindSheet(
  cells: readonly ExpCell[],
  seed: number,
  context: { conversation: readonly string[]; model: string; runs: number },
): { md: string; key: Record<string, { line: ExpCell["key"]; cond: ExperienceCond; run: number }> } {
  const rnd = mulberry32(seed);
  const key: Record<string, { line: ExpCell["key"]; cond: ExperienceCond; run: number }> = {};
  const md: string[] = [
    "# 경험 실험 가린 비교표",
    "",
    `- 모델 ${context.model} · 발화 ${cells.length}개 × 조건 3 × ${context.runs}회 · 윤재만`,
    "- 윤재의 Core·장면·앞 대화·듣기 전 마음·마지막 플레이어 발화는 모두 같다. 다른 것은 윤재가 기억하는 한 달 전 일뿐이다.",
    "- 어느 조건에서 나온 대사인지 숨기고 무작위로 섞었다. 조건은 셋이다.",
    "  - **A:** 한 달 전 플레이어가 \"회의 있는 날은 답 늦어도 재촉 안 하고 기다릴게\"라고 약속했는데, 그 주에 재촉 메시지를 연달아 보내 그날 밤 다퉜다",
    "  - **B:** 같은 약속을 했고, 그 주 내내 지켰다",
    "  - **C:** 그 일에 대한 정보가 없다",
    "",
    "## 평가 방법",
    "",
    "- **추측:** 어느 조건 같은지 A/B/C (모르겠으면 ?)",
    "- **자연스러움 1~3:** 실제 연인이 이 상황에서 할 법한 말인가",
    "- **Core 부합 1~3:** 윤재다운가",
    "- **메모:** 근거가 된 표현, 과거에 얽매였거나(새 말을 아예 안 받아들임) 과거만 믿고 오늘 일을 쉽게 넘긴 것 같은 점",
    "",
    "## 앞 대화 (모든 대사에 같음)",
    "",
    ...context.conversation,
    "",
  ];
  let n = 0;
  for (const c of cells) {
    const finals = c.gens.filter((g) => g.ok && g.final);
    if (!finals.length) continue;
    md.push(`## 마지막 플레이어 발화: "${c.line}"`, "", "| 번호 | 윤재의 반응 | 추측 (A/B/C/?) | 자연스러움 | Core 부합 | 메모 |", "| --- | --- | --- | --- | --- | --- |");
    for (const g of shuffled(finals, rnd)) {
      n++;
      key[String(n)] = { line: c.key, cond: g.cond, run: g.run };
      md.push(`| ${n} | ${beatsText(g.final).replace(/\|/g, "\\|")} |  |  |  |  |`);
    }
    md.push("");
  }
  return { md: md.join("\n"), key };
}

const shiftText = (s: ExpGen["shift"]) => (s?.length ? s.map((x) => `${x.axis} ${x.delta > 0 ? "+1" : "-1"}`).join(", ") : "변화 없음");

/** 해석 검토표 (가리지 않음): 발화마다 조건별 속마음 필드와 대사 */
export function reviewSheet(cells: readonly ExpCell[], memories: Record<ExperienceCond, string | null>): string {
  const md: string[] = [
    "# 경험 실험 해석 검토표",
    "",
    "가린 비교를 마친 뒤에 본다. 속마음 필드(heard·focus·belief·standard)는 모델의 자기 설명이다. **설명만으로 성공이라고 보지 않는다.** 대사에 같은 차이가 드러나는지를 함께 본다.",
    "",
    "## 조건별 이전 경험 (프롬프트에 들어간 그대로)",
    "",
    ...CONDS.flatMap((k) => [`**${COND_LABEL[k]}**`, "", memories[k] ? memories[k]!.split("\n").map((l) => `> ${l}`).join("\n") : "> (블록 없음)", ""]),
  ];
  for (const c of cells) {
    md.push(`## 플레이어: "${c.line}"`, "", `보려는 것: ${c.about}`, "", `1차 기록 (세 조건 공통): ${c.factsFailure ? `실패 — ${c.factsFailure}` : c.factsSummary ?? "-"}`, "");
    for (const cond of CONDS) {
      md.push(`### ${COND_LABEL[cond]}`, "");
      for (const g of c.gens.filter((x) => x.cond === cond)) {
        if (!g.ok) {
          md.push(`- **${g.run}회: 실패** — ${g.failure}`, "");
          continue;
        }
        const rejected = g.drafts.filter((d) => d.violations.length && d.attempt < g.drafts.length);
        md.push(
          `- **${g.run}회 대사:** ${beatsText(g.final)}${g.endsWithQuestion ? " (질문으로 끝남)" : ""}${mentionsPast(dialogueOf(g.final)) ? " 〔대사에서 과거 언급〕" : ""}`,
          `  - heard: ${g.heard}`,
          `  - focus(가장 크게 본 것): ${g.focus}`,
          `  - belief(플레이어에 대해): ${g.belief}`,
          `  - standard(판단 기준, 중요한 순): ${(g.standard ?? []).map((s, i) => `${i + 1}) ${s}`).join(" ")}`,
          `  - want: ${g.want || "(없음)"} · shift: ${shiftText(g.shift)}`,
          ...rejected.map((d) => `  - 거부된 ${d.attempt}번째 시도 [${d.violations.map(violationKind).join(", ")}]: ${beatsText(d.beats)}`),
          "",
        );
      }
    }
    md.push(
      "### 판단 (탐색 실험: 경험이 해석과 반응에 영향을 주는가)",
      "",
      "| 질문 | A 어김 | B 지킴 | C 없음 |",
      "| --- | --- | --- | --- |",
      "| 1. 사건의 어떤 측면을 중요하게 봤나 |  |  |  |",
      "| 2. 플레이어에 대한 신뢰·기대 |  |  |  |",
      "| 3. 판단 기준·우선순위가 C와 달라 보이나 (자기 설명 기준, 결론 아님) |  |  |  |",
      "| 4. 그 차이가 대사·행동에 보이나 |  |  |  |",
      "| 반대 가능성: A에서 새 말을 받아들일 여지를 남겼나 (얽매임이 아닌가) |  |  | - |",
      "| 반대 가능성: B에서 오늘 일을 과거만 믿고 쉽게 넘기지 않았나 |  |  | - |",
      "| Core와 이전 경험에서 납득되는 반응인가 |  |  |  |",
      "",
      "- 새 약속을 의심하는 것은 플레이어에 대한 **신뢰·기대가 달라진 결과**일 수 있다. 약속과 무관한 발화에서 판단이 달라져도 **평가 기준이 바뀌었다고 바로 결론 내리지 않는다**: 신뢰 변화가 번진 것일 수도 있다.",
      "",
    );
  }
  return md.join("\n");
}

/** 요약: 발화 × 조건별 성공·과거 언급·질문 끝맺음·거부·shift 분포 */
export function summaryLines(cells: readonly ExpCell[]): string[] {
  const md: string[] = [];
  const pct = (a: number, b: number) => (b ? `${a}/${b}` : "-");
  for (const c of cells) {
    md.push(`### 플레이어: "${c.line}" (${c.key === "same" ? "같은 영역" : "전이 탐침"})`, "", "| | A 어김 | B 지킴 | C 없음 |", "| --- | --- | --- | --- |");
    const of = (k: ExperienceCond) => c.gens.filter((g) => g.cond === k);
    const oks = (k: ExperienceCond) => of(k).filter((g) => g.ok);
    const row = (label: string, f: (k: ExperienceCond) => string) => md.push(`| ${label} | ${CONDS.map(f).join(" | ")} |`);
    row("생성 성공", (k) => pct(oks(k).length, of(k).length));
    row("대사에서 과거 언급 (거친 표시)", (k) => pct(oks(k).filter((g) => mentionsPast(dialogueOf(g.final))).length, oks(k).length));
    row("속마음에서 과거 언급 (거친 표시)", (k) => pct(oks(k).filter((g) => mentionsPast(innerOf(g))).length, oks(k).length));
    row("질문으로 끝남", (k) => pct(oks(k).filter((g) => g.endsWithQuestion).length, oks(k).length));
    row("거부된 시도", (k) => {
      const v = oks(k).flatMap((g) => g.drafts.filter((d) => d.attempt < g.drafts.length).flatMap((d) => d.violations.map(violationKind)));
      return v.length ? Object.entries(v.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>)).map(([a, n]) => `${a} ${n}`).join(", ") : "0";
    });
    row("shift", (k) => {
      const all = oks(k).flatMap((g) => (g.shift?.length ? g.shift.map((x) => `${x.axis}${x.delta > 0 ? "+" : "-"}`) : ["없음"]));
      return Object.entries(all.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>)).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(", ");
    });
    md.push("");
  }
  return md;
}
