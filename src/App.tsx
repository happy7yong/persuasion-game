import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Beat, type Ending as EndingData, type StartResponse, type Stats } from "./api";
import { Ending } from "./Ending";

type Msg = { id: number; who: "npc" | "me"; beat: Beat };
type Phase = "intro" | "chat" | "closing" | "ending";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const chars = (s: string) => Array.from(s).length;

export function App() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [stats, setStats] = useState<Stats | null>(null);
  const [game, setGame] = useState<StartResponse | null>(null);
  const [ending, setEnding] = useState<{ data: EndingData; stats: Stats | null } | null>(null);
  const tokenRef = useRef("");

  useEffect(() => {
    void api.stats().then(setStats);
  }, []);

  const begin = (g: StartResponse) => {
    tokenRef.current = g.token;
    setGame(g);
    setEnding(null);
    setPhase("chat");
  };

  const reveal = (data: EndingData, s: Stats | null) => {
    setEnding({ data, stats: s });
    setPhase("ending");
    window.scrollTo({ top: 0 });
  };

  if (phase === "intro" || !game) return <Intro stats={stats} onStart={begin} />;
  if (phase === "ending" && ending)
    return (
      <Ending
        data={ending.data}
        stats={ending.stats}
        npcName={game.scenario.npcName}
        onRetry={() => {
          setPhase("intro");
          void api.stats().then(setStats);
        }}
      />
    );
  return <Chat game={game} tokenRef={tokenRef} closing={phase === "closing"} onClosing={() => setPhase("closing")} onEnding={reveal} />;
}

function Intro({ stats, onStart }: { stats: Stats | null; onStart: (g: StartResponse) => void }) {
  const [consent, setConsent] = useState(false);
  const [heard, setHeard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    if (!consent) return setError("시작하려면 대화 기록 활용에 동의해 주세요.");
    setBusy(true);
    setError("");
    try {
      onStart(await api.start(true, heard));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "문제가 생겼어요. 다시 시도해 주세요.");
      setBusy(false);
    }
  };

  return (
    <main className="intro">
      <div className="intro-card">
        <p className="intro-scene">금요일 밤, 동네 카페</p>
        <h1 className="intro-title">우리 얘기 좀 해</h1>
        <p className="intro-lede">
          오늘 하루 종일 연락이 없던 연인 윤재.
          <br />
          다섯 마디 안에 윤재의 마음을 돌릴 수 있을까요?
        </p>
        <div className="intro-count" aria-live="polite">
          {stats && stats.finished > 0 ? (
            <>
              <strong>
                {stats.finished}명 중 {stats.persuaded}명
              </strong>
              이 윤재를 설득했어요
            </>
          ) : (
            <>아직 아무도 윤재를 설득하지 못했어요</>
          )}
        </div>
        <ul className="intro-rules">
          <li>말할 기회는 다섯 번, 쓸 수 있는 글자는 모두 600자예요.</li>
          <li>한번 한 말은 고칠 수 없어요.</li>
          <li>윤재가 얼마나 흔들렸는지는 끝나야 알 수 있어요.</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => (setConsent(e.target.checked), setError(""))} />
          <span>대화 내용이 이름 없이 연구용으로 저장되는 것에 동의해요. 상대는 AI이고, 개인정보는 쓰지 말아 주세요.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={heard} onChange={(e) => setHeard(e.target.checked)} />
          <span>이 게임에 대해 미리 들어봤어요</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" onClick={start} disabled={busy}>
          {busy ? "카페로 가는 중…" : "대화 시작하기"}
        </button>
      </div>
    </main>
  );
}

function KakaoCard({ game }: { game: StartResponse }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="kakao">
      <button className="kakao-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        오늘 주고받은 메시지 {open ? "접기" : "보기"}
      </button>
      {open && (
        <ol className="kakao-list">
          {game.scenario.kakao.map((k, i) => (
            <li key={i} className={`kakao-row ${k.from}`}>
              {k.readAt && <div className="kakao-read">{k.readAt} 읽음</div>}
              <div className="kakao-line">
                <span className="kakao-bubble">{k.text}</span>
                <time>{k.time}</time>
              </div>
            </li>
          ))}
          <li className="kakao-note">답장 없이 지나간 시간 약 8시간 반 · 그 사이 보낸 메시지 7개</li>
        </ol>
      )}
    </section>
  );
}

function Chat({
  game,
  tokenRef,
  closing,
  onClosing,
  onEnding,
}: {
  game: StartResponse;
  tokenRef: React.MutableRefObject<string>;
  closing: boolean;
  onClosing: () => void;
  onEnding: (e: EndingData, s: Stats | null) => void;
}) {
  const { rules, scenario } = game;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState(0);
  const [left, setLeft] = useState(rules.charBudget);
  const [busy, setBusy] = useState(true);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const [confirmGiveup, setConfirmGiveup] = useState(false);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const push = (who: Msg["who"], beat: Beat) => setMsgs((m) => [...m, { id: idRef.current++, who, beat }]);

  const playBeats = async (beats: Beat[]) => {
    for (const b of beats) {
      setTyping(true);
      await wait(reduceMotion() ? 0 : Math.min(1400, 450 + chars(b.content) * 18));
      setTyping(false);
      push("npc", b);
      await wait(reduceMotion() ? 0 : 250);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void playBeats(scenario.opening).then(() => setBusy(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "end" });
  }, [msgs, typing, closing]);

  const goEnding = async (giveup: boolean) => {
    onClosing();
    setError("");
    await wait(reduceMotion() ? 0 : 1600);
    try {
      const res = await api.finish(tokenRef.current, giveup);
      tokenRef.current = res.token;
      onEnding(res.ending, res.stats);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "결과를 불러오지 못했어요. 다시 시도해 주세요.");
    }
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg) return setError("할 말을 입력해 주세요.");
    if (chars(msg) > rules.messageMax) return setError(`한 번에 ${rules.messageMax}자까지 말할 수 있어요.`);
    if (chars(msg) > left) return setError(`발언권이 ${left}자 남았어요.`);
    setBusy(true);
    setError("");
    push("me", { type: "dialogue", content: msg });
    setText("");
    setTyping(true);
    try {
      const res = await api.turn(tokenRef.current, msg);
      tokenRef.current = res.token;
      setTurns(res.turnsUsed);
      setLeft(res.charsLeft);
      setTyping(false);
      await playBeats(res.beats);
      if (res.finished) {
        setFinished(true);
        await wait(reduceMotion() ? 0 : 900);
        await goEnding(false);
      } else setBusy(false);
    } catch (e) {
      setTyping(false);
      setMsgs((m) => m.slice(0, -1));
      setText(msg);
      setError(e instanceof ApiError ? e.message : "문제가 생겼어요. 다시 보내 주세요.");
      setBusy(false);
    }
  };

  const msgLen = chars(text);
  const over = msgLen > rules.messageMax || msgLen > left;
  const pct = Math.max(0, (left / rules.charBudget) * 100);

  return (
    <main className="chat">
      <header className="chat-head">
        <div>
          <h1 className="chat-name">{scenario.npcName}</h1>
          <p className="chat-place">{scenario.place}</p>
        </div>
        <div className="chat-meter">
          <span className="chat-turn">
            {Math.min(turns + 1, rules.maxTurns)}/{rules.maxTurns}번째 말
          </span>
          <div className="budget" role="meter" aria-label="남은 발언권" aria-valuemin={0} aria-valuemax={rules.charBudget} aria-valuenow={left}>
            <div className="budget-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="chat-left">발언권 {left}자</span>
        </div>
      </header>

      <KakaoCard game={game} />

      <ol className="thread" aria-live="polite">
        {msgs.map((m) =>
          m.beat.type === "narration" ? (
            <li key={m.id} className="beat-narr">
              {m.beat.content}
            </li>
          ) : (
            <li key={m.id} className={`bubble ${m.who}`}>
              {m.beat.content}
            </li>
          ),
        )}
        {typing && (
          <li className="typing" aria-label={`${scenario.npcName}가 말을 고르는 중`}>
            <span />
            <span />
            <span />
          </li>
        )}
        {closing && <li className="closing">위원회 발언 시간이 종료되었습니다</li>}
      </ol>
      <div ref={endRef} className="thread-end" />

      {closing ? (
        error && (
          <div className="composer">
            <p className="error" role="alert">{error}</p>
            <button className="primary" onClick={() => void goEnding(!finished)}>
              결과 다시 불러오기
            </button>
          </div>
        )
      ) : (
        <div className="composer">
          <textarea
            value={text}
            onChange={(e) => (setText(e.target.value), setError(""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!busy) void send();
              }
            }}
            placeholder={busy ? "" : `${scenario.npcName}에게 하고 싶은 말`}
            rows={3}
            disabled={busy}
            aria-label={`${scenario.npcName}에게 할 말`}
            aria-invalid={over}
          />
          <div className="composer-bar">
            <span className={`count ${over ? "over" : ""}`}>
              {msgLen}/{Math.min(rules.messageMax, left)}자
            </span>
            {confirmGiveup ? (
              <span className="giveup-confirm">
                정말 그만할까요?
                <button className="link" onClick={() => void goEnding(true)}>
                  그만하기
                </button>
                <button className="link" onClick={() => setConfirmGiveup(false)}>
                  계속하기
                </button>
              </span>
            ) : (
              <button className="link" onClick={() => setConfirmGiveup(true)} disabled={busy}>
                포기하기
              </button>
            )}
            <button className="primary small" onClick={() => void send()} disabled={busy || over}>
              말하기
            </button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="composer-hint">한번 한 말은 고칠 수 없어요.</p>
        </div>
      )}
    </main>
  );
}
