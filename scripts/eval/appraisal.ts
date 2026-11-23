// 실험 1 (캐릭터 직접 해석, docs/appraisal-review.md §14)의 결과 정리. LLM을 부르지 않는 순수 함수만 둔다.
// - 가린 비교표: 조건(A·B)과 해석 필드를 숨기고 최종 대사만 섞어 보여 준다. 정답 키는 따로 저장한다
// - 해석 검토표: B의 heard·shift·want와 대사를 윤재·서아 나란히
// - 요약: 거부 사유(V1~V4), V2가 막은 근거, 빈 shift 비율, 질문으로 끝난 비율

export type Beat = { type: "narration" | "dialogue"; content: string };
export interface Draft {
  attempt: number;
  /** "ok" 또는 거부·실패 이유 */
  result: string;
  beats: Beat[] | null;
  violations: string[];
}
/** V2가 막은 근거: 어느 장부 항목이, 1차의 어떤 기록 때문에 정리 상태였나 */
export interface V2Hit {
  attempt: number;
  id: string;
  text: string;
  resolvedBy: string;
}
export interface Gen {
  cond: "A" | "B";
  run: number;
  ok: boolean;
  failure?: string;
  drafts: Draft[];
  final?: Beat[];
  outcome?: string;
  /** A: 서버가 생성 전에 정한 끝맺음 */
  move?: string;
  /** 생성 뒤 분류: 마지막 대사가 질문으로 끝나는가 */
  endsWithQuestion?: boolean;
  thought?: string;
  heard?: string;
  shift?: { axis: string; delta: number; why: string }[];
  want?: string;
  refs: string[];
  v2: V2Hit[];
}
export interface Cell {
  idx: number;
  line: string;
  about: string;
  partner: "m" | "f";
  name: string;
  /** 1차가 기록한 것 (A·B가 같이 쓴다) */
  factsSummary?: string;
  factsFailure?: string;
  gens: Gen[];
}

export const VIOLATION_KINDS = ["V1 반복", "V2 재주장", "V3 장면", "V4 끝맺음", "기타"] as const;
export function violationKind(v: string): (typeof VIOLATION_KINDS)[number] {
  if (v.startsWith("reply_repeats")) return "V1 반복";
  if (v.startsWith("reasserts_resolved")) return "V2 재주장";
  if (v.startsWith("scene_contradiction")) return "V3 장면";
  if (v.startsWith("move_violation")) return "V4 끝맺음";
  return "기타";
}

/** 시도별 대사와 그 시도의 위반을 묶는다 (첫 대사와 최종 대사를 나눠 보려고) */
export function draftsFrom(attempts: readonly { result: string; responseText: string | null }[], checks: readonly { attempt: number; violations: string[] }[]): Draft[] {
  return attempts.map((a, i) => {
    let beats: Beat[] | null = null;
    try {
      const text = a.responseText ?? "";
      const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { beats?: Beat[] };
      beats = Array.isArray(j.beats) ? j.beats : null;
    } catch {
      beats = null;
    }
    return { attempt: i + 1, result: a.result, beats, violations: checks.find((c) => c.attempt === i + 1)?.violations ?? [] };
  });
}

export const beatsText = (beats: readonly Beat[] | null | undefined): string =>
  beats?.length ? beats.map((b) => (b.type === "narration" ? `*${b.content}*` : b.content)).join(" / ") : "(없음)";

const cellKey = (c: Pick<Cell, "idx" | "partner">) => `${c.idx + 1}-${c.partner}`;

/** 재현 가능한 섞기 (시드를 결과에 남긴다) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const LABELS = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"];

/**
 * 가린 비교표. 최종 대사만, 조건·해석·검증 결과 없이. 같은 발화·같은 캐릭터 안에서 A·B를 섞는다.
 * key: "1-m:가" → { cond, run } (평가 뒤에 연다)
 */
export function blindSheet(cells: readonly Cell[], seed: number): { md: string; key: Record<string, { cond: "A" | "B"; run: number }> } {
  const rnd = mulberry32(seed);
  const key: Record<string, { cond: "A" | "B"; run: number }> = {};
  const md: string[] = [
    "# 실험 1 가린 비교표",
    "",
    "어느 조건에서 만든 대사인지 숨겼다. 같은 상황(앞 대화 1마디 + 플레이어의 말)에 대한 연인의 반응이다. 각 대사를 1~3으로 매긴다 (3이 가장 좋음).",
    "- **자연스러움:** 실제 연인이 이 상황에서 할 법한 말인가",
    "- **캐릭터다움:** 이 인물의 성격(아래 한 줄)에 맞는가",
    "- **맥락 일관성:** 앞 대화와 방금 말에 맞게 반응했는가",
    "",
    "정답 키는 `blind-key.json`에 있다. 평가를 마친 뒤에 연다.",
    "",
  ];
  for (const c of cells) {
    const finals = c.gens.filter((g) => g.ok && g.final);
    if (!finals.length) continue;
    md.push(`## ${c.idx + 1}. ${c.name} — 플레이어: "${c.line}"`, "", "| 표시 | 연인의 반응 | 자연스러움 | 캐릭터다움 | 맥락 일관성 | 메모 |", "| --- | --- | --- | --- | --- | --- |");
    shuffled(finals, rnd).forEach((g, i) => {
      const label = LABELS[i]!;
      key[`${cellKey(c)}:${label}`] = { cond: g.cond, run: g.run };
      md.push(`| ${label} | ${beatsText(g.final).replace(/\|/g, "\\|")} |  |  |  |  |`);
    });
    md.push("");
  }
  return { md: md.join("\n"), key };
}

const shiftText = (s: Gen["shift"]) => (s?.length ? s.map((x) => `${x.axis} ${x.delta > 0 ? "+1" : "-1"} (${x.why})`).join(", ") : "변화 없음");

/** 해석 검토표 (가리지 않음): B의 해석과 대사를 윤재·서아 나란히, A의 속마음과 대사도 함께 */
export function reviewSheet(cells: readonly Cell[]): string {
  const md: string[] = [
    "# 실험 1 해석 검토표",
    "",
    "가린 비교를 마친 뒤에 본다. 발화마다 아래를 판단한다.",
    "- B의 해석(heard·shift·want)이 Core와 문맥에 맞는가",
    "- 그 해석이 **실제 대사에 드러나는가** (대사와 모순되면 표시)",
    "- 윤재·서아의 해석이 다르다면 Core의 어느 부분이 근거인가. 같다면 같은 게 자연스러운 상황인가 (같은 캐릭터 3회 안의 흔들림보다 차이가 일관되게 클 때만 \"다름\")",
    "- 감정 변화가 없을 상황에서 변화를 지어내지 않았는가",
    "",
  ];
  const byIdx = new Map<number, Cell[]>();
  for (const c of cells) byIdx.set(c.idx, [...(byIdx.get(c.idx) ?? []), c]);
  for (const [idx, cs] of byIdx) {
    md.push(`## ${idx + 1}. 플레이어: "${cs[0]!.line}"`, "", `보려는 것: ${cs[0]!.about}`, "");
    for (const c of cs) {
      md.push(`### ${c.name}`, "", `1차 기록 (A·B 공통): ${c.factsFailure ? `실패 — ${c.factsFailure}` : c.factsSummary ?? "-"}`, "");
      for (const cond of ["B", "A"] as const) {
        md.push(`**${cond === "B" ? "B (직접 해석)" : "A (기존)"}**`, "");
        for (const g of c.gens.filter((x) => x.cond === cond)) {
          if (!g.ok) {
            md.push(`- ${g.run}회: 실패 — ${g.failure}`);
            continue;
          }
          const first = g.drafts[0];
          const rejected = g.drafts.filter((d) => d.violations.length && d.attempt < g.drafts.length);
          md.push(
            cond === "B"
              ? `- ${g.run}회 · heard: ${g.heard} · shift: ${shiftText(g.shift)} · want: ${g.want || "(없음)"}`
              : `- ${g.run}회 · 끝맺음(미리 정함): ${g.move} · thought: ${g.thought}`,
            `  - 최종 대사: ${beatsText(g.final)}${g.endsWithQuestion ? " (질문으로 끝남)" : ""}`,
            ...rejected.map((d) => `  - 거부된 ${d.attempt}번째 시도 [${d.violations.map(violationKind).join(", ")}: ${d.violations.join(" | ").slice(0, 120)}]: ${beatsText(d.beats)}`),
            ...(first && !rejected.length && g.drafts.length > 1 ? [`  - 첫 시도(형식 오류 등): ${first.result.slice(0, 80)}`] : []),
          );
        }
        md.push("");
      }
    }
    md.push("| 판단 | 윤재 | 서아 |", "| --- | --- | --- |", "| 해석이 Core·문맥에 맞나 |  |  |", "| 해석이 대사에 드러나나 |  |  |", "| 지어낸 변화가 있나 |  |  |", "", "| 윤재 vs 서아 | 같음 / 표현만 다름 / 해석·판단이 다름 | Core 근거 |", "| --- | --- | --- |", "|  |  |  |", "");
  }
  return md.join("\n");
}

/** 요약: 조건별 결과 분류·거부 사유·V2 영향·빈 shift·질문 끝맺음 */
export function summaryLines(cells: readonly Cell[]): string[] {
  const gens = cells.flatMap((c) => c.gens.map((g) => ({ c, g })));
  const md: string[] = [];
  const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "-");
  md.push("| | A (기존) | B (직접 해석) |", "| --- | --- | --- |");
  const row = (label: string, f: (cond: "A" | "B") => string) => md.push(`| ${label} | ${f("A")} | ${f("B")} |`);
  const of = (cond: "A" | "B") => gens.filter((x) => x.g.cond === cond);
  const oks = (cond: "A" | "B") => of(cond).filter((x) => x.g.ok);
  row("생성 성공", (k) => pct(oks(k).length, of(k).length));
  for (const o of ["clean", "prevented", "exposed"]) row(`결과 ${o}`, (k) => String(oks(k).filter((x) => x.g.outcome === o).length));
  for (const kind of VIOLATION_KINDS) {
    row(`거부된 시도: ${kind}`, (k) => String(oks(k).flatMap((x) => x.g.drafts).flatMap((d) => d.violations.map(violationKind)).filter((v) => v === kind).length));
  }
  row("질문으로 끝남", (k) => pct(oks(k).filter((x) => x.g.endsWithQuestion).length, oks(k).length));
  row("shift 비어 있음 (전체)", (k) => (k === "A" ? "해당 없음" : pct(oks(k).filter((x) => !x.g.shift?.length).length, oks(k).length)));
  const last = Math.max(...cells.map((c) => c.idx));
  row(`shift 비어 있음 (${last + 1}번 대조군)`, (k) => (k === "A" ? "해당 없음" : pct(oks(k).filter((x) => x.c.idx === last && !x.g.shift?.length).length, oks(k).filter((x) => x.c.idx === last).length)));
  row("want 비어 있음", (k) => (k === "A" ? "해당 없음" : pct(oks(k).filter((x) => !x.g.want).length, oks(k).length)));
  row("A의 끝맺음 (미리 정함)", (k) => (k === "B" ? "정하지 않음" : Object.entries(oks(k).reduce((m, x) => ((m[x.g.move ?? "-"] = (m[x.g.move ?? "-"] ?? 0) + 1), m), {} as Record<string, number>)).map(([a, n]) => `${a} ${n}`).join(", ")));
  md.push("");

  const hits = gens.flatMap(({ c, g }) => g.v2.map((h) => ({ c, g, h })));
  md.push("### V2가 막은 대사 (근거: 1차가 기록한 정리 상태)", "");
  if (!hits.length) md.push("- 없음", "");
  else {
    md.push("| 조건 | 발화 | 연인 | 시도 | 막힌 항목 | 그 항목이 정리 상태였던 근거 (1차 기록) | 막힌 대사 | 최종 대사 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { c, g, h } of hits) {
      const d = g.drafts.find((x) => x.attempt === h.attempt);
      md.push(`| ${g.cond} | ${c.idx + 1} | ${c.name} | ${h.attempt}${h.attempt === g.drafts.length ? " (마지막: 노출)" : ""} | ${h.id} ${h.text} | ${h.resolvedBy} | ${beatsText(d?.beats)} | ${beatsText(g.final)} |`);
    }
    md.push("");
  }
  return md;
}
