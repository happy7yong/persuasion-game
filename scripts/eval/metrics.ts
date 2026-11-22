// 평가 지표 (순수 함수). 엔진 코드를 바꾸지 않고, 엔진이 낸 결과를 읽어서 센다.
import type { TurnFacts } from "../../server/ledger.js";

type Beat = { type: "narration" | "dialogue"; content: string };

/** server/npc.ts의 ENDS_WITH_QUESTION과 같은 정의 (V4가 질문으로 보는 기준). 평가 전용 사본이다. */
const ENDS_WITH_QUESTION = /[?？]\s*[)"”’…~.]*\s*$/u;

/** 이 마디의 대사 중 하나라도 질문으로 끝나는가 (V4와 같은 기준) */
export const hasQuestion = (beats: readonly Beat[]): boolean => beats.some((b) => b.type === "dialogue" && ENDS_WITH_QUESTION.test(b.content.trim()));

export const dialogueOf = (beats: readonly Beat[]) => beats.filter((b) => b.type === "dialogue").map((b) => b.content).join(" ");
export const narrationOf = (beats: readonly Beat[]) => beats.filter((b) => b.type === "narration").map((b) => b.content).join(" ");

/** 반복 표현 (character-intent.md §2 Q4에서 실제 대사로 센 것과 같은 기준) */
export const MOTIFS: { key: string; where: "dialogue" | "narration"; re: RegExp }[] = [
  { key: "행동: 라떼·빨대·잔·컵", where: "narration", re: /라떼|빨대|잔을|잔 |컵/ },
  { key: "대사: 제일 서운", where: "dialogue", re: /제일 서운/ },
  { key: "대사: 일부러 … 아니", where: "dialogue", re: /일부러[^.?!]{0,12}(아니|않)/ },
  { key: "대사: 문두 근데·다만·그래도", where: "dialogue", re: /(^|[.!?…]\s*)(근데|다만|그래도)/ },
];

export function motifHits(beats: readonly Beat[]): string[] {
  return MOTIFS.filter((m) => m.re.test(m.where === "dialogue" ? dialogueOf(beats) : narrationOf(beats))).map((m) => m.key);
}

export function bigrams(text: string): string[] {
  const t = text.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
  return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2));
}

/** 여러 대사 전체의 서로 다른 2-gram 비율 (1에 가까울수록 표현이 다양) */
export function distinctRatio(lines: readonly string[]): number {
  const all = lines.flatMap(bigrams);
  return all.length ? new Set(all).size / all.length : 1;
}

const dice = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let s = 0;
  for (const x of a) if (b.has(x)) s++;
  return (2 * s) / (a.size + b.size);
};

/** 각 대사가 그 앞의 모든 연인 대사 중 가장 많이 겹친 정도 (V1은 바로 앞 대사만 본다. 이건 전체를 본다) */
export function echoOverlaps(lines: readonly string[]): number[] {
  const sets = lines.map((l) => new Set(bigrams(l)));
  return sets.map((s, i) => (i === 0 ? 0 : Math.max(...sets.slice(0, i).map((p) => dice(s, p)))));
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
}
export function summarize(xs: readonly number[]): Summary {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}
export const fmt = (s: Summary, digits = 2) => (s.n ? `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)} (${s.min.toFixed(digits)}~${s.max.toFixed(digits)}, n=${s.n})` : "-");

/** 1차가 낸 원래 항목 수 (검증에서 버려지기 전). responseText를 읽기만 한다 */
export function rawFactsCounts(responseText: string | null): { items: number; resolves: number; acts: number } | null {
  if (!responseText) return null;
  try {
    const s = responseText.indexOf("{");
    const raw = JSON.parse(responseText.slice(s, responseText.lastIndexOf("}") + 1)) as Record<string, unknown[]>;
    const len = (k: string) => (Array.isArray(raw[k]) ? raw[k]!.length : 0);
    return { items: len("npcLast") + len("playerNew"), resolves: len("npcResolved") + len("playerResolved"), acts: len("acts") };
  } catch {
    return null;
  }
}

/** 확정된 사실에서 검증을 통과한 항목 수 */
export const acceptedFactsCounts = (f: TurnFacts) => ({ items: f.added.length, resolves: f.resolved.length, acts: f.acts.filter((a) => a.quote).length });

/**
 * 같은 입력을 여러 번 돌렸을 때 기록이 같은지 비교하기 위한 요약.
 * 새 항목의 id는 실행마다 달라질 수 있어서, 정리된 항목은 장면 시작·앞 마디에서 이미 있던 id만, 새 항목은 (누가·종류)만 본다.
 */
export function factsSignature(f: TurnFacts, knownIds: ReadonlySet<string>): string {
  const acts = [...new Set(f.acts.map((a) => a.act))].sort().join(",");
  const resolved = f.resolved.filter((r) => knownIds.has(r.id)).map((r) => `${r.id}:${r.status}`).sort().join(",");
  const added = f.added.map((a) => `${a.by}:${a.kind}`).sort().join(",");
  return `acts[${acts}] resolved[${resolved}] added[${added}]`;
}

/** 가장 흔한 요약이 전체에서 차지하는 비율 (1 = 매번 같게 기록) */
export function agreement(signatures: readonly string[]): { modal: string; rate: number } {
  const counts = new Map<string, number>();
  for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1);
  let modal = "";
  let best = 0;
  for (const [k, v] of counts) if (v > best) (modal = k), (best = v);
  return { modal, rate: signatures.length ? best / signatures.length : 0 };
}
