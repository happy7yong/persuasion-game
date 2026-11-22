// 대화 리포트: 마디마다 내 말, 연인의 대답, 움직인 %(+), 연인의 속마음.
import { useEffect, useState } from "react";
import type { Report, Stats } from "./api";
import { BeliefCard } from "./BeliefCard";
import { track } from "./clarity";
import { ResultSummary } from "./ResultSummary";
import { Distribution } from "./Distribution";
import { shareUrl } from "./share";

export function ReportView({ report, stats, token, onRetry, preview = false }: { report: Report; stats: Stats | null; token: string; onRetry: () => void; preview?: boolean }) {
  const { npcName, outcome, shake, successShake, turns } = report;
  const [copied, setCopied] = useState("");

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  const share = async () => {
    track("share_clicked");
    // 링크를 열면 첫 화면에 내 결과 카드가 보인다 (src/share.ts)
    const url = shareUrl(report);
    const text = `나는 ${npcName}의 마음을 ${shake}% 움직였다. 너는?`;
    try {
      if (navigator.share) await navigator.share({ text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        setCopied("결과 링크를 복사했어요.");
      }
    } catch {
      /* 공유 창을 닫은 경우 */
    }
  };

  return (
    <main className="report" data-clarity-unmask="true">
      <ResultSummary npcName={npcName} outcome={outcome} shake={shake} successShake={successShake}>
        {stats && stats.best !== null && (
          <p className="report-best">{shake >= stats.best ? "지금까지 최고 기록이에요!" : `지금까지 최고 기록은 ${stats.best}%예요.`}</p>
        )}
      </ResultSummary>

      {stats?.distribution && <Distribution counts={stats.distribution} shake={shake} successShake={successShake} />}

      <h2 className="report-h">마디별로 보기</h2>
      <ol className="report-turns">
        {turns.map((t) => {
          const badge = t.turn === report.strongestTurn ? "가장 많이 움직인 말" : t.turn === report.weakestTurn ? "가장 덜 움직인 말" : null;
          return (
            <li key={t.turn} id={`turn-${t.turn}`} className={`turn-card ${t.turn === report.strongestTurn ? "best" : ""}`}>
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

      <BeliefCard token={token} npcName={npcName} preview={preview} />

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
