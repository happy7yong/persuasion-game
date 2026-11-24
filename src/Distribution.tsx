// 결과 화면: 다른 사람들은 연인과 몇 % 통했는지 (10% 구간 막대) + 내 순위.
// 참여자가 MIN_FOR_COUNT명 모이기 전에는 사람 수(전체·구간별)를 밝히지 않는다.
// 분포는 판이 끝날 때 서버에서 한 번 받아 결과와 함께 저장한다 (실시간으로 다시 묻지 않는다).
// 그림: 내 구간만 강조색, 나머지는 회색 (emphasis). 구간별 사람 수는 막대를 누르면 위에 나온다.
import { useState } from "react";
import { binOf, MIN_FOR_COUNT, MIN_FOR_RANK, rankOf, toBins } from "./rank";

export function Distribution({ counts, shake, successShake }: { counts: number[]; shake: number; successShake: number }) {
  const bins = toBins(counts);
  const mineBin = binOf(shake);
  // 내 판이 아직 분포에 없으면(저장 실패 등) 내 구간에 나를 더해서 그린다
  if ((counts[Math.round(shake)] ?? 0) === 0) bins[mineBin]!.n += 1;
  const max = Math.max(1, ...bins.map((b) => b.n));
  const rank = rankOf(counts, shake);
  const [active, setActive] = useState<number | null>(null);
  const shown = active ?? mineBin;
  const label = (i: number) => `${bins[i]!.from}~${bins[i]!.to}%`;

  if (!rank) return null;
  const showCounts = rank.total >= MIN_FOR_COUNT;

  return (
    <section className="dist" aria-labelledby="dist-title">
      <h2 id="dist-title" className="dist-title">
        다른 사람들은 몇 % 통했을까?
      </h2>
      {rank.total >= MIN_FOR_RANK ? (
        <p className="dist-rank">
          <span className="dist-rank-number">상위 {rank.top}%</span>
        </p>
      ) : (
        <p className="dist-rank-sub">
          아직 참여자가 많지 않아서, 순위는 조금 더 모이면 보여 드릴게요.
        </p>
      )}

      <div className="dist-chart">
        <p className="dist-readout" aria-live="polite">
          {showCounts && <b>{bins[shown]!.n}명</b>} {label(shown)}
          {shown === mineBin && <span className="dist-me-tag">나</span>}
        </p>
        <div className="dist-plot">
          <div className="dist-goal" style={{ left: `${successShake}%` }} aria-hidden="true">
            <span>설득 성공</span>
          </div>
          <ol className="dist-bars" aria-label={`통한 % 구간별 분포. 내 결과는 ${label(mineBin)} 구간`}>
            {bins.map((b, i) => (
              <li
                key={i}
                className={`dist-col ${i === mineBin ? "me" : ""} ${i === active ? "on" : ""}`}
                tabIndex={0}
                aria-label={`${label(i)}${showCounts ? `: ${b.n}명` : ""}${i === mineBin ? ", 나" : ""}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {i === mineBin && <span className="dist-me">나</span>}
                <span className="dist-bar" style={{ height: b.n === 0 ? 0 : `max(3px, ${(b.n / max) * 100}%)` }} />
              </li>
            ))}
          </ol>
        </div>
        <div className="dist-axis" aria-hidden="true">
          <span>0%</span>
          <span>50%</span>
          <span>100%</span>
        </div>
      </div>
    </section>
  );
}
