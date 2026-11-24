// 결과 공유 링크: 첫 화면에서 친구가 연인과 몇 % 통했는지 보여 준다.
//   /?s=63&p=m&o=compromise&g=70   (s 움직인 %, p 연인, o 결과, g 설득 성공 기준 %)
// 값은 링크에만 있고 서버에서 검증하지 않는다. 자랑용 숫자라 범위와 종류만 확인한다.
import { PARTNER_OPTIONS, type Outcome, type Partner } from "./api";

export interface SharedResult {
  partner: Partner;
  npcName: string;
  shake: number;
  successShake: number;
  outcome: Outcome;
}

const OUTCOMES: Outcome[] = ["success", "compromise", "breakdown", "giveup"];
const KEYS = ["s", "p", "o", "g"] as const;

const percent = (v: string | null): number | null => {
  if (v === null || !/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 0 && n <= 100 ? n : null;
};

export function shareUrl(r: { npcName: string; shake: number; successShake: number; outcome: Outcome }): string {
  const partner = PARTNER_OPTIONS.find((o) => o.name === r.npcName)?.key ?? "m";
  const q = new URLSearchParams({ s: String(r.shake), p: partner, o: r.outcome, g: String(r.successShake) });
  return `${location.origin}/?${q}`;
}

export function readSharedResult(search: string = location.search): SharedResult | null {
  const q = new URLSearchParams(search);
  const shake = percent(q.get("s"));
  const successShake = percent(q.get("g"));
  const option = PARTNER_OPTIONS.find((o) => o.key === q.get("p"));
  const outcome = OUTCOMES.find((o) => o === q.get("o"));
  if (shake === null || successShake === null || !option || !outcome) return null;
  return { partner: option.key, npcName: option.name, shake, successShake, outcome };
}

/** 게임을 시작하면 주소에서 공유 값을 지운다 (다시 첫 화면으로 와도 친구 결과가 남지 않게). */
export function clearSharedParams(): void {
  const q = new URLSearchParams(location.search);
  if (!KEYS.some((k) => q.has(k))) return;
  for (const k of KEYS) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
}

/** 개발자용 예시 (?dev=shared) */
export const DEV_SHARED: SharedResult = { partner: "m", npcName: "윤재", shake: 63, successShake: 70, outcome: "compromise" };
