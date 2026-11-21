// "○○가 본 너": 대화가 끝난 뒤 연인이 플레이어를 어떻게 봤는지 (server/belief.ts).
// 연인의 관점이라 틀릴 수 있다는 것을 먼저 밝히고, 판단마다 근거가 된 말을 붙인다.
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Belief } from "./api";
import { track } from "./clarity";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; belief: Belief };

function goToTurn(turn: number) {
  const el = document.getElementById(`turn-${turn}`);
  if (!el) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1400);
}

export function BeliefCard({ token, npcName }: { token: string; npcName: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [verdict, setVerdict] = useState<"agree" | "disagree" | null>(null);
  const [saving, setSaving] = useState(false);
  const started = useRef(false);

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const { belief } = await api.belief(token);
      setState({ kind: "ready", belief });
      track("belief_shown");
    } catch (e) {
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "불러오지 못했어요." });
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, []);

  const answer = async (v: "agree" | "disagree") => {
    setSaving(true);
    try {
      await api.feedback(token, v);
      setVerdict(v);
      track(v === "agree" ? "belief_agree" : "belief_disagree");
    } catch {
      /* 저장에 실패하면 다시 누를 수 있게 둔다 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="belief" aria-labelledby="belief-title" data-clarity-unmask="true">
      <h2 id="belief-title" className="belief-title">
        {npcName}가 본 너
      </h2>
      <p className="belief-desc">다섯 마디 동안 {npcName}가 느낀 대로예요. {npcName}의 관점이라 틀릴 수 있어요.</p>

      {state.kind === "loading" && (
        <div className="belief-loading" role="status">
          <span className="spinner small" aria-hidden="true" />
          {npcName}가 너를 어떻게 봤는지 정리하는 중…
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
        <>
          <blockquote className="belief-summary">{state.belief.summary}</blockquote>
          <ol className="belief-points">
            {state.belief.points.map((p, i) => (
              <li key={i}>
                <p className="belief-claim">{p.claim}</p>
                <button className="evidence" onClick={() => goToTurn(p.turn)} aria-label={`근거: ${p.turn}번째 말로 이동`}>
                  <span className="evidence-label">근거 · {p.turn}번째 말</span>
                  <span className="evidence-quote">“{p.quote}”</span>
                </button>
                <p className="belief-why">{p.why}</p>
              </li>
            ))}
          </ol>
          <p className="belief-expect">{state.belief.expectation}</p>

          <div className="belief-feedback">
            {verdict ? (
              <p role="status">{verdict === "agree" ? `${npcName}한테 전해 둘게요.` : `${npcName}가 다음엔 더 잘 볼 수 있게 기록해 둘게요.`}</p>
            ) : (
              <>
                <p>{npcName}가 본 너, 맞는 것 같아요?</p>
                <div className="belief-buttons">
                  <button className="secondary small" onClick={() => void answer("agree")} disabled={saving}>
                    맞아
                  </button>
                  <button className="secondary small" onClick={() => void answer("disagree")} disabled={saving}>
                    좀 달라
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
