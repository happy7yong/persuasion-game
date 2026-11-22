// 은하 신문 1면 (server/headline.ts): 사실 이 대화는 은하연애위원회에 생중계되고 있었다.
// 리포트 숫자를 먼저 보여 주고, 신문은 뒤에서 불러온다. 실패해도 리포트는 그대로다.
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Headline } from "./api";
import { track } from "./clarity";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; headline: Headline };

function goToTurn(turn: number) {
  const el = document.getElementById(`turn-${turn}`);
  if (!el) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1400);
}

export function HeadlineCard({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const { headline } = await api.headline(token);
      setState({ kind: "ready", headline });
      track("headline_shown");
    } catch (e) {
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "불러오지 못했어요." });
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, []);

  return (
    <section className="galaxy" aria-labelledby="galaxy-reveal" data-clarity-unmask="true">
      <p id="galaxy-reveal" className="galaxy-reveal">
        <span className="galaxy-live">● LIVE</span>
        사실 이 대화는 <b>은하연애위원회</b>에 생중계되고 있었습니다.
      </p>

      {state.kind === "loading" && (
        <div className="paper paper-loading" role="status">
          <div className="paper-mast">은하 연합 타임스 3026년 특별판</div>
          <p>
            <span className="spinner small" aria-hidden="true" />
            1,000년 뒤 신문을 인쇄하는 중…
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="notice error">
          <p>{state.message}</p>
          <button className="primary small" onClick={() => void load()}>
            다시 불러오기
          </button>
        </div>
      )}

      {state.kind === "ready" && (
        <article className="paper">
          <div className="paper-mast">은하 연합 타임스 3026년 특별판</div>
          <h2 className="paper-title">{state.headline.title}</h2>
          <p className="paper-sub">{state.headline.subtitle}</p>
          <button className="paper-quote" onClick={() => goToTurn(state.headline.quoteTurn)} aria-label={`${state.headline.quoteTurn}번째 말로 이동`}>
            “{state.headline.quote}”
            <span className="paper-quote-src">— {state.headline.quoteTurn}번째 말, 지구의 한 카페에서</span>
          </button>
          <p className="paper-textbook">
            <span>은하 역사 교과서 1장</span> {state.headline.textbook}
          </p>
          <ul className="paper-side">
            {state.headline.sideArticles.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
