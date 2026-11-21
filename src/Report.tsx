// 대화 리포트: 마디마다 내 말, 연인의 대답, 움직인 %(+), 연인의 속마음.
import { useEffect, useState } from "react";
import type { Outcome, Report, Stats } from "./api";
import { track } from "./clarity";

// 연인 이름은 모두 받침이 없어 조사가 같다 (server/content.ts PARTNERS)
const OUTCOME: Record<Outcome, { name: string; note: (npc: string) => string }> = {
  success: { name: "설득 성공", note: (n) => `${n}의 마음을 돌렸어요.` },
  compromise: { name: "타협", note: () => "완전히 넘어오진 않았지만, 꽤 가까워졌어요." },
  breakdown: { name: "결렬", note: (n) => `${n}는 아직 생각이 그대로예요.` },
  giveup: { name: "포기", note: () => "대화를 중간에 멈췄어요." },
};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useCountUp(to: number): number {
  const [n, setN] = useState(reduceMotion() ? to : 0);
  useEffect(() => {
    if (reduceMotion()) return setN(to);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1200);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return n;
}

export function ReportView({ report, stats, onRetry }: { report: Report; stats: Stats | null; onRetry: () => void }) {
  const { npcName, outcome, shake, successShake, turns } = report;
  const shown = useCountUp(shake);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  const share = async () => {
    track("share_clicked");
    const text = `나는 ${npcName}의 마음을 ${shake}% 움직였다. 너는?\n${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied("결과 문구를 복사했어요.");
      }
    } catch {
      /* 공유 창을 닫은 경우 */
    }
  };

  return (
    <main className="report" data-clarity-unmask="true">
      <section className="report-summary">
        <p className={`report-outcome ${outcome}`}>{OUTCOME[outcome].name}</p>
        <h1 className="report-title">
          {npcName}의 마음을
          <span className="report-number">{shown}%</span>
          움직였어요
        </h1>
        <div
          className="meter"
          role="meter"
          aria-label={`${npcName}의 마음을 움직인 정도`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shake}
        >
          <div className="meter-fill" style={{ width: `${shown}%` }} />
          <div className="meter-goal" style={{ left: `${successShake}%` }}>
            <span>설득 성공 {successShake}%</span>
          </div>
        </div>
        <p className="report-note">
          {OUTCOME[outcome].note(npcName)}
          {outcome !== "success" && shake < successShake && ` 설득까지 ${successShake - shake}% 남았어요.`}
        </p>
        {stats && stats.best !== null && (
          <p className="report-best">{shake >= stats.best ? "지금까지 최고 기록이에요!" : `지금까지 최고 기록은 ${stats.best}%예요.`}</p>
        )}
      </section>

      <h2 className="report-h">마디별로 보기</h2>
      <ol className="report-turns">
        {turns.map((t) => {
          const badge = t.turn === report.strongestTurn ? "가장 많이 움직인 말" : t.turn === report.weakestTurn ? "가장 덜 움직인 말" : null;
          return (
            <li key={t.turn} className={`turn-card ${t.turn === report.strongestTurn ? "best" : ""}`}>
              <div className="turn-head">
                <span className="turn-no">{t.turn}번째 말</span>
                {badge && <span className="turn-badge">{badge}</span>}
                <span className="turn-gain">+{t.gain}%</span>
              </div>
              <div className="turn-track" aria-hidden="true">
                <div className="turn-track-prev" style={{ width: `${t.total - t.gain}%` }} />
                <div className="turn-track-gain" style={{ width: `${t.gain}%` }} />
              </div>
              <p className="turn-total">누적 {t.total}%</p>
              <dl className="turn-lines">
                <dt>나</dt>
                <dd className="line-me">{t.player}</dd>
                <dt>{npcName}</dt>
                <dd className="line-npc">
                  {t.npc.map((b, i) =>
                    b.type === "narration" ? (
                      <span key={i} className="line-narr">
                        {b.content}
                      </span>
                    ) : (
                      <span key={i} className="line-say">
                        {b.content}
                      </span>
                    ),
                  )}
                </dd>
              </dl>
              {t.thought && (
                <figure className="thought">
                  <figcaption>{npcName}의 속마음</figcaption>
                  <blockquote>{t.thought}</blockquote>
                </figure>
              )}
            </li>
          );
        })}
      </ol>

      <div className="report-actions">
        <button className="primary" onClick={() => (track("retry_clicked"), onRetry())}>
          다시 도전하기
        </button>
        <button className="secondary" onClick={() => void share()}>
          결과 공유하기
        </button>
        {copied && (
          <p className="copied" role="status">
            {copied}
          </p>
        )}
      </div>
    </main>
  );
}
