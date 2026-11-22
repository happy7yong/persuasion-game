// 결과 분포와 순위: 서버가 준 % 분포(길이 101)로 계산한다. 화면에서 한 번만 계산하면 된다.

/** 이만큼 모이기 전에는 "상위 N%"를 보여 주지 않는다 (몇 명으로 순위를 매기면 오해를 산다) */
export const MIN_FOR_RANK = 10;

export interface Bin {
  from: number;
  to: number;
  n: number;
}

/** 10% 단위 구간 10개: 0~9, 10~19, …, 90~100 */
export function toBins(counts: readonly number[]): Bin[] {
  return Array.from({ length: 10 }, (_, i) => {
    const from = i * 10;
    const to = i === 9 ? 100 : from + 9;
    let n = 0;
    for (let s = from; s <= to; s++) n += counts[s] ?? 0;
    return { from, to, n };
  });
}

export const binOf = (shake: number): number => Math.min(9, Math.floor(Math.max(0, Math.min(100, shake)) / 10));

export interface Rank {
  /** 비교한 전체 판 수 (나 포함) */
  total: number;
  /** 나보다 많이 움직인 판 수 + 1 (같은 %는 같은 순위) */
  rank: number;
  /** 상위 몇 % (1~100) */
  top: number;
}

/**
 * 내 %가 전체에서 어디쯤인지. 분포에 내 판이 아직 없으면(저장 실패 등) 나를 더해서 센다.
 */
export function rankOf(counts: readonly number[], mine: number): Rank | null {
  const me = Math.max(0, Math.min(100, Math.round(mine)));
  let total = 0;
  let above = 0;
  for (let s = 0; s <= 100; s++) {
    const n = counts[s] ?? 0;
    total += n;
    if (s > me) above += n;
  }
  if ((counts[me] ?? 0) === 0) total += 1;
  if (total === 0) return null;
  const rank = above + 1;
  return { total, rank, top: Math.max(1, Math.ceil((rank / total) * 100)) };
}

/** 개발자용 예시 분포 (?dev=result): 30% 근처에 몰린 모양 */
export function sampleDistribution(): number[] {
  return Array.from({ length: 101 }, (_, s) => Math.round(9 * Math.exp(-((s - 34) ** 2) / (2 * 14 ** 2))));
}
