import { useEffect, useRef, useState } from "react";
import type { Ending as EndingData, Outcome, Stats } from "./api";

const OUTCOME: Record<Outcome, { name: string; note: string }> = {
  success: { name: "설득 성공", note: "윤재의 마음을 돌렸어요." },
  compromise: { name: "타협", note: "둘이 함께 정한 약속이 생겼어요." },
  breakdown: { name: "결렬", note: "윤재는 아직 생각이 그대로예요." },
  giveup: { name: "포기", note: "대화를 중간에 멈췄어요." },
};
const SUCCESS_SHAKE = 60;
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function CountUp({ to }: { to: number }) {
  const [n, setN] = useState(reduceMotion() ? to : 0);
  useEffect(() => {
    if (reduceMotion()) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1400);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{n}</>;
}

export function Ending({ data, stats, npcName, onRetry }: { data: EndingData; stats: Stats | null; npcName: string; onRetry: () => void }) {
  const { plan, chains } = data;
  const steps = 1 + chains.length + 4; // 방송 시작, 마디별 폭발, 갈림길, 신문, 결과, 마지막
  const [step, setStep] = useState(reduceMotion() ? steps : 0);
  const [copied, setCopied] = useState("");
  const lastRef = useRef<HTMLDivElement>(null);
  const chainStart = 1;
  const forkStep = chainStart + chains.length;

  useEffect(() => {
    if (step >= steps) return;
    const isChain = step >= chainStart && step < forkStep;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 2200 : isChain ? 3200 : 2600);
    return () => clearTimeout(t);
  }, [step, steps]);

  useEffect(() => {
    if (step > 0 && step < steps) lastRef.current?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "end" });
  }, [step]);

  const share = async () => {
    const text = `나는 ${npcName}의 마음을 ${plan.shake}% 흔들었다. 너는?\n${location.origin}`;
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

  const line = (turn: number | null) => plan.lines.find((l) => l.turn === turn);
  const strongest = line(plan.strongestTurn);
  const weakest = line(plan.weakestTurn);
  const tickerItems = [data.headline.title, ...data.sideArticles];

  return (
    <main className="galaxy">
      {step >= chainStart && (
        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            {[...tickerItems, ...tickerItems].map((t, i) => (
              <span key={i}>속보 {t}</span>
            ))}
          </div>
        </div>
      )}

      <section className="g-open">
        <p className="g-small">방금 당신이 한 말들이 전송된 곳</p>
        <h1 className="g-display">은하연애위원회 본회의장</h1>
      </section>

      {chains.map(
        (c, i) =>
          step >= chainStart + i && (
            <section key={c.turn} className="g-chain">
              <p className="g-quote">“{c.line}”</p>
              <p className="g-drop">
                {npcName}의 마음 <strong>-{c.drop}%</strong>
              </p>
              <ol className="g-events">
                {c.events.map((e, j) => (
                  <li key={j} style={{ animationDelay: `${0.5 + j * 0.8}s` }}>
                    <span className="g-year">{e.year}</span>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          ),
      )}

      {step >= forkStep && (
        <section className="g-forks">
          <h2 className="g-h">당신의 말이 고른 미래</h2>
          {plan.forks.map((f) => (
            <div key={f.era} className="fork">
              <div className="fork-era">
                {f.era}
                <span>{f.basis}로 갈림</span>
              </div>
              <div className="fork-chosen">{f.chosen}</div>
              {line(f.decidingTurn) && <p className="fork-why">이 미래를 정한 말: “{line(f.decidingTurn)!.text}”</p>}
              <ul className="fork-untaken" aria-label="갈라지지 않은 미래">
                {f.untaken.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {step >= forkStep + 1 && (
        <section className="paper">
          <div className="paper-mast">은하 연합 타임스 · 3026년 특별판</div>
          <h2 className="paper-title">{data.headline.title}</h2>
          <p className="paper-sub">{data.headline.subtitle}</p>
          <blockquote className="paper-quote">“{data.headline.quote}”</blockquote>
          <p className="paper-textbook">은하 역사 교과서 1장 · {data.textbook}</p>
          <ul className="paper-side">
            {data.sideArticles.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      {step >= forkStep + 2 && (
        <section className="result">
          <p className="result-outcome">{OUTCOME[plan.outcome].name}</p>
          <p className="result-shake">
            {npcName}의 마음을 <strong><CountUp to={plan.shake} />%</strong> 흔들었어요
          </p>
          <p className="result-note">
            {OUTCOME[plan.outcome].note}
            {plan.outcome !== "success" && plan.shake < SUCCESS_SHAKE && ` 설득까지 ${SUCCESS_SHAKE - plan.shake}% 남았어요.`}
          </p>
          {stats && stats.finished > 0 && (
            <p className="result-stats">
              지금까지 {stats.finished}명 중 {stats.persuaded}명이 {npcName}를 설득했어요
            </p>
          )}
          {strongest && (
            <div className="result-line">
              <span>가장 크게 흔든 말 · -{strongest.drop}%</span>“{strongest.text}”
            </div>
          )}
          {weakest && (
            <div className="result-line weak">
              <span>가장 약했던 말 · -{weakest.drop}%</span>“{weakest.text}”
            </div>
          )}
          <div className="result-untaken">
            <span>갈라지지 않은 미래</span>
            <p>{data.untaken.instead}</p>
            <ul>
              {data.untaken.events.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {step >= forkStep + 3 && (
        <section className="quiet">
          <p>
            은하연애위원회는 없지만,
            <br />
            오늘 당신이 고른 말들은 진짜였어요.
          </p>
          {strongest && <p className="quiet-line">“{strongest.text}”</p>}
          <div className="quiet-actions">
            <button className="primary light" onClick={onRetry}>
              다시 도전하기
            </button>
            <button className="ghost" onClick={() => void share()}>
              결과 공유하기
            </button>
          </div>
          {copied && <p className="copied" role="status">{copied}</p>}
        </section>
      )}

      <div ref={lastRef} />
      {step < steps && (
        <button className="skip" onClick={() => setStep(steps)}>
          한 번에 보기
        </button>
      )}
    </main>
  );
}
