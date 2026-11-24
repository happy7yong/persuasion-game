// 가치 실험 (docs/character-intent.md §6)의 결과 정리. LLM을 부르지 않는 순수 함수만 둔다.
// 실험 1(appraisal.ts)의 섞기·대사 정리·위반 분류를 그대로 쓴다.

import { beatsText, mulberry32, shuffled, violationKind, type Beat, type Draft } from "./appraisal.js";

export type ValueCond = "base" | "value";
export const VALUE_COND_LABEL: Record<ValueCond, string> = { base: "기존 Core", value: "기존 Core + 가치 단락" };

export interface ValueGen {
  cond: ValueCond;
  run: number;
  ok: boolean;
  failure?: string;
  drafts: Draft[];
  final?: Beat[];
  /** 모델이 고른 끝맺음 (첫 마디는 counter·ask 중 모델이 고른다) */
  move?: string;
  thought?: string;
  outcome?: string;
  respondedModel?: string;
}
export interface ValueCell {
  idx: number;
  line: string;
  about: string;
  /** 1차 기록과 점수 (두 조건 공통) */
  facts?: { suggested: number; labels: string[]; reason: string; noticed: string; summary: string };
  factsFailure?: string;
  /** 1차 원본 (다음 비교에서 같은 1차를 다시 쓰려고 남긴다) */
  raw?: unknown;
  gens: ValueGen[];
}

/**
 * 가린 비교표. 발화마다 두 조건의 최종 대사를 섞고 전체에 1부터 번호를 붙인다.
 * 조건·속마음·끝맺음·검증 결과·점수는 넣지 않는다. key: "3" → { idx, cond, run }
 */
export function blindSheet(cells: readonly ValueCell[], seed: number, context: { kakao: readonly string[]; opening: readonly string[]; model: string; runs: number }) {
  const rnd = mulberry32(seed);
  const key: Record<string, { idx: number; cond: ValueCond; run: number }> = {};
  const md: string[] = [
    "# 가치 실험 가린 비교표",
    "",
    `- 모델 ${context.model} · 윤재 · 플레이어 발화 ${cells.length}개 × 조건 2 × ${context.runs}회 · 첫 마디`,
    "- 같은 장면에서 같은 첫마디를 들은 윤재의 반응이다. 두 조건 중 무엇에서 나온 대사인지 숨기고 섞었다.",
    "- 정답 반응은 없다. **상황을 자연스럽고 일관되게 해석하는지, 예상 밖의 말에도 윤재의 가치관에 맞게 반응하는지**를 본다.",
    "",
    "## 평가 방법",
    "",
    "- **자연스러움:** ○ 괜찮음 · △ 애매 · ✕ 어색",
    "- **해석:** 이 말을 윤재답게, 앞뒤가 맞게 받아들였나 (○ · △ · ✕)",
    "- **메모:** 한 줄. 다 채우지 않아도 된다. 거슬린 번호와 이유만 있어도 충분하다",
    "",
    "## 플레이어가 대화 전에 본 카톡",
    "",
    ...context.kakao,
    "",
    "## 장면 시작 (윤재)",
    "",
    ...context.opening,
    "",
  ];
  let n = 0;
  for (const c of cells) {
    const finals = c.gens.filter((g) => g.ok && g.final);
    if (!finals.length) continue;
    md.push(`## 플레이어 첫마디: "${c.line}"`, "", "| 번호 | 윤재의 반응 | 자연스러움 | 해석 | 메모 |", "| --- | --- | --- | --- | --- |");
    for (const g of shuffled(finals, rnd)) {
      n++;
      key[String(n)] = { idx: c.idx, cond: g.cond, run: g.run };
      md.push(`| ${n} | ${beatsText(g.final).replace(/\|/g, "\\|")} |  |  |  |`);
    }
    md.push("");
  }
  return { md: md.join("\n"), key };
}

/** 평가 뒤에 여는 검토표: 조건별 대사·속마음·끝맺음·거부된 시도, 발화별 1차 점수(두 조건 공통) */
export function reviewSheet(cells: readonly ValueCell[], addition: string, constraints: readonly string[]): string {
  const md: string[] = [
    "# 가치 실험 검토표 (평가 뒤에 연다)",
    "",
    "## 더한 가치 단락 (조건 value에만, Core의 \"중요하게 생각하는 것\" 절 끝)",
    "",
    `> ${addition}`,
    "",
    "## 대사에 영향을 준 제약 (두 조건 공통, 바꾸지 않았다)",
    "",
    ...constraints.map((c) => `- ${c}`),
    "",
  ];
  for (const c of cells) {
    md.push(`## 플레이어: "${c.line}" (${c.about})`, "");
    md.push(c.facts ? `- 1차 (두 조건 공통): 점수 제안 ${c.facts.suggested} · 라벨 ${c.facts.labels.join(", ") || "-"} · 근거: ${c.facts.reason} · 알게 된 것: ${c.facts.noticed}` : `- 1차 실패: ${c.factsFailure}`);
    if (c.facts) md.push(`- 1차 기록: ${c.facts.summary}`);
    md.push("");
    for (const cond of ["base", "value"] as const) {
      md.push(`### ${VALUE_COND_LABEL[cond]}`, "");
      for (const g of c.gens.filter((x) => x.cond === cond)) {
        if (!g.ok) {
          md.push(`- ${g.run}회: 실패 — ${g.failure}`, "");
          continue;
        }
        const rejected = g.drafts.filter((d) => d.violations.length && d.attempt < g.drafts.length);
        md.push(
          `- **${g.run}회:** ${beatsText(g.final)}`,
          `  - 끝맺음(모델이 고름): ${g.move} · 속마음: ${g.thought} · 응답 모델: ${g.respondedModel ?? "-"}`,
          ...rejected.map((d) => `  - 거부된 ${d.attempt}번째 시도 [${d.violations.map(violationKind).join(", ")}: ${d.violations.join(" | ").slice(0, 120)}]: ${beatsText(d.beats)}`),
          "",
        );
      }
    }
  }
  return md.join("\n");
}
