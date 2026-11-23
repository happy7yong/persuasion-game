// V3 재판정: 이미 저장된 평가 결과의 연인 대사를 다시 판정한다 (대사 생성 LLM은 부르지 않는다).
// 용도는 V3 판정 정확도 검증뿐이다. 재생성 이후 대사가 더 자연스러워졌는지는 이걸로 판단하지 않는다.
import type { SceneCase } from "./cases.js";

type Beat = { type: "narration" | "dialogue"; content: string };

/** 커밋 9c754a0 시점(기준선)의 V3 거름망. "예전 거름망에 걸렸나"를 다시 계산하는 데 쓴다. 바꾸지 않는다 */
export const SCENE_TRIGGERS_9c754a0: readonly { key: string; re: RegExp }[] = [
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
export const oldTriggers = (text: string) => SCENE_TRIGGERS_9c754a0.filter((t) => t.re.test(text)).map((t) => t.key);

/** 저장된 결과에서 읽는 모양 (scripts/eval.ts의 RunResult 일부) */
export interface SavedTurn {
  turn: number;
  player: string;
  ok: boolean;
  beats?: Beat[];
  outcome?: string;
  violations?: string[][];
  /** 예전 결과: "[위반] 내용 / 내용" 문자열 */
  rejected?: string[];
  /** 새 결과: 시도별 구조화된 대사. result는 "ok" 또는 "invalid_output:위반 | 위반" (형식 오류 포함) */
  attempts?: { attempt: number; result: string; beats: Beat[] | null }[];
}
export interface SavedRun {
  config: string;
  run: number;
  partner: "m" | "f";
  turns: SavedTurn[];
}

export type OldService = "막음" | "통과(판정)" | "통과(거름망 밖)";

export interface RejudgeItem {
  /** 같은 (플레이어 말, 대사)는 한 번만 판정한다 */
  key: string;
  partner: "m" | "f";
  player: string;
  dialogue: string;
  /** final: 플레이어에게 보인 대사 · rejected: 거부된 시도 */
  role: "final" | "rejected";
  /** 대사·행동 구분을 이름 접두어로 추정했는가 (예전 결과의 거부된 시도) */
  heuristic: boolean;
  oldService: OldService;
  where: string;
}

const dialogueOf = (beats: readonly Beat[]) => beats.filter((b) => b.type === "dialogue").map((b) => b.content).join(" ");

/**
 * 예전 결과의 거부된 시도는 "내용 / 내용"으로만 남아 있다. 행동 묘사는 보통 "서아가 …", "윤재는 …"로 시작하므로
 * 그 조각을 빼고 대사로 본다 (추정, heuristic 표시).
 */
export function splitRejected(text: string, npcName: string): string {
  return text
    .split(" / ")
    .map((x) => x.trim())
    .filter((x) => x && !new RegExp(`^\\*?${npcName}(가|는|의|도)\\s`).test(x))
    .join(" ");
}

function oldServiceOf(violations: readonly string[], dialogue: string): OldService {
  if (violations.some((v) => v.startsWith("scene_contradiction"))) return "막음";
  return oldTriggers(dialogue).length ? "통과(판정)" : "통과(거름망 밖)";
}

/** 저장된 실행들에서 판정할 대사를 모두 꺼낸다 (최종 대사 + 거부된 시도 + 재시도) */
export function extractItems(runs: readonly SavedRun[], names: Record<"m" | "f", string>, sourceLabel: string): RejudgeItem[] {
  const out: RejudgeItem[] = [];
  for (const r of runs) {
    for (const t of r.turns) {
      if (!t.ok || !t.beats) continue;
      const where = `${sourceLabel} ${r.config} 실행${r.run + 1} ${t.turn}마디`;
      const viol = t.violations ?? [];
      if (t.attempts?.length) {
        // 새 결과: 시도별 구조화 (마지막이 최종)
        t.attempts.forEach((a, i) => {
          if (!a.beats) return;
          const d = dialogueOf(a.beats);
          if (!d) return;
          const last = i === t.attempts!.length - 1;
          // 거부된 시도는 그 시도의 결과 문자열에서, 최종 대사는 마지막 검증 기록에서 위반을 읽는다
          const v = last ? (viol.at(-1) ?? []) : a.result.replace(/^invalid_output:/, "").split(" | ");
          out.push({ key: `${r.partner}|${t.player}|${d}`, partner: r.partner, player: t.player, dialogue: d, role: last ? "final" : "rejected", heuristic: false, oldService: oldServiceOf(v, d), where: `${where} ${a.attempt}차` });
        });
        continue;
      }
      // 예전 결과: 최종 대사는 beats, 거부된 시도는 문자열
      for (const [i, s] of (t.rejected ?? []).entries()) {
        const m = s.match(/^\[([^\]]*)\]\s*(.*)$/s);
        if (!m) continue;
        const d = splitRejected(m[2]!, names[r.partner]);
        if (!d) continue;
        out.push({ key: `${r.partner}|${t.player}|${d}`, partner: r.partner, player: t.player, dialogue: d, role: "rejected", heuristic: true, oldService: oldServiceOf(m[1]!.split(" | "), d), where: `${where} 거부${i + 1}` });
      }
      const d = dialogueOf(t.beats);
      if (d) out.push({ key: `${r.partner}|${t.player}|${d}`, partner: r.partner, player: t.player, dialogue: d, role: "final", heuristic: false, oldService: oldServiceOf(viol.at(-1) ?? [], d), where: `${where} 최종` });
    }
  }
  return out;
}

const squash = (t: string) => t.replace(/[\s"'“”‘’.,!?~…·]/g, "");

/** 사람이 검토한 실제 사례(cases.ts의 source "real")와 맞으면 그 판정 (짧게 줄인 사례도 원문에 포함되면 같은 대사로 본다) */
export function humanLabel(dialogue: string, player: string, cases: readonly SceneCase[]): "contradiction" | "ok" | undefined {
  const d = squash(dialogue);
  const hit = cases.find((c) => c.source === "real" && squash(c.player) === squash(player) && (d.includes(squash(c.line)) || squash(c.line).includes(d)));
  return hit?.expect;
}
