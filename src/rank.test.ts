// 결과 분포와 순위 계산
import { describe, expect, it } from "vitest";
import { binOf, rankOf, toBins } from "./rank";

const dist = (pairs: [number, number][]) => {
  const c = new Array<number>(101).fill(0);
  for (const [s, n] of pairs) c[s] = n;
  return c;
};

describe("구간", () => {
  it("10% 단위 10개, 마지막 구간은 100까지", () => {
    const b = toBins(dist([[0, 1], [9, 2], [10, 3], [95, 1], [100, 4]]));
    expect(b).toHaveLength(10);
    expect(b[0]).toEqual({ from: 0, to: 9, n: 3 });
    expect(b[1]!.n).toBe(3);
    expect(b[9]).toEqual({ from: 90, to: 100, n: 5 });
  });
  it("내 %가 속한 구간", () => {
    expect([0, 9, 10, 63, 99, 100].map(binOf)).toEqual([0, 0, 1, 6, 9, 9]);
  });
});

describe("순위", () => {
  it("나보다 많이 움직인 사람 수 + 1, 같은 %는 같은 순위", () => {
    // 20명: 70%에 1명, 50%에 4명(나 포함), 30%에 15명
    const r = rankOf(dist([[70, 1], [50, 4], [30, 15]]), 50);
    expect(r).toEqual({ total: 20, rank: 2, top: 10 });
  });
  it("가장 많이 움직였으면 최소 상위 1%", () => {
    expect(rankOf(dist([[90, 1], [10, 199]]), 90)!.top).toBe(1);
  });
  it("분포에 내 판이 없으면 나를 더해서 센다", () => {
    expect(rankOf(dist([[40, 9]]), 60)).toEqual({ total: 10, rank: 1, top: 10 });
  });
  it("아무도 없으면 나 혼자", () => {
    expect(rankOf(dist([]), 30)).toEqual({ total: 1, rank: 1, top: 100 });
  });
});
