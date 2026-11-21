import { useEffect, useRef, useState } from "react";
import { api, ApiError, newKey, type Beat, type Exchange, type StartResponse, type Stats } from "./api";
import { Ending } from "./Ending";
import { tag, tagPlay, track } from "./clarity";
import { clearGame, loadGame, saveGame, type Msg, type SavedGame } from "./storage";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const chars = (s: string) => Array.from(s).length;

export function App() {
  const [session, setSession] = useState<SavedGame | null>(() => loadGame());
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!session) void api.stats().then(setStats);
  }, [session === null]);

  useEffect(() => {
    if (session) saveGame(session);
  }, [session]);

  useEffect(() => {
    if (session?.game.playId) tagPlay(session.game.playId);
  }, [session?.game.playId]);

  const restart = () => {
    clearGame();
    setSession(null);
    window.scrollTo({ top: 0 });
  };

  if (!session) {
    return (
      <Intro
        stats={stats}
        onStart={(g) =>
          setSession({ v: 1, game: g, token: g.token, msgs: [], turns: 0, left: g.rules.charBudget, finished: false, ending: null })
        }
      />
    );
  }
  if (session.ending) {
    return <Ending data={session.ending.data} stats={session.ending.stats} npcName={session.game.scenario.npcName} onRetry={restart} />;
  }
  return <Chat session={session} update={(patch) => setSession((s) => (s ? { ...s, ...patch } : s))} onRestart={restart} />;
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
      onStart(await api.start(heard));
      track("game_started");
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
          <span>대화 내용이 이름 없이 연구용으로 저장되고, 화면 이용 과정(대화 포함)이 Microsoft Clarity로 기록되는 것에 동의해요. 상대는 AI이고, 개인정보는 쓰지 말아 주세요.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={heard} onChange={(e) => setHeard(e.target.checked)} />
          <span>이 게임에 대해 미리 들어봤어요</span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
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

type Notice = { kind: "error" | "info"; text: string; action?: "restart" | "finish" };

function Chat({ session, update, onRestart }: { session: SavedGame; update: (p: Partial<SavedGame>) => void; onRestart: () => void }) {
  const { game } = session;
  const { rules, scenario } = game;
  const [msgs, setMsgs] = useState<Msg[]>(session.msgs);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const [typing, setTyping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmGiveup, setConfirmGiveup] = useState(false);
  const tokenRef = useRef(session.token);
  const pending = useRef<{ text: string; key: string } | null>(null);
  const idRef = useRef(session.msgs.reduce((m, x) => Math.max(m, x.id + 1), 0));
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  // 화면에 보이는 대화를 저장해 둔다 (새로고침 복구)
  useEffect(() => {
    update({ msgs });
  }, [msgs]);

  const push = (who: Msg["who"], beat: Beat): number => {
    const id = idRef.current++; // 업데이트 함수 밖에서 정해야 StrictMode 이중 실행에도 id가 그대로다
    setMsgs((m) => [...m, { id, who, beat }]);
    return id;
  };

  const playBeats = async (beats: Beat[], animate = true) => {
    for (const b of beats) {
      if (animate && !reduceMotion()) {
        setTyping(true);
        await wait(Math.min(1400, 450 + chars(b.content) * 18));
        setTyping(false);
      }
      push("npc", b);
      if (animate && !reduceMotion()) await wait(250);
    }
  };

  const applyProgress = (p: { token: string; turnsUsed: number; charsLeft: number; finished: boolean }) => {
    tokenRef.current = p.token;
    update({ token: p.token, turns: p.turnsUsed, left: p.charsLeft, finished: p.finished });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (session.msgs.length === 0) void playBeats(scenario.opening).then(() => setBusy(false));
    else if (session.finished) void goEnding(false);
    else setBusy(false);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "end" });
  }, [msgs, typing, closing]);

  const goEnding = async (giveup: boolean) => {
    setClosing(true);
    setNotice(null);
    await wait(reduceMotion() ? 0 : 1600);
    try {
      const res = await api.finish(tokenRef.current, giveup);
      tokenRef.current = res.token;
      update({ token: res.token, finished: true, ending: { data: res.ending, stats: res.stats } });
      tag("outcome", res.ending.plan.outcome);
      tag("shake", String(res.ending.plan.shake));
      track(giveup ? "game_given_up" : "ending_shown");
      window.scrollTo({ top: 0 });
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setNotice({
        kind: "error",
        text: err?.message ?? "결과를 불러오지 못했어요. 다시 시도해 주세요.",
        action: err?.code === "session_expired" ? "restart" : "finish",
      });
    }
  };

  /** 서버 기록에 맞춰 대화를 이어 붙인다 (응답을 못 받았던 마디 포함). */
  const appendExchanges = async (exchanges: Exchange[], animateLast: boolean) => {
    for (const [i, ex] of exchanges.entries()) {
      push("me", { type: "dialogue", content: ex.player });
      await playBeats(ex.beats, animateLast && i === exchanges.length - 1);
    }
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg) return setNotice({ kind: "error", text: "할 말을 입력해 주세요." });
    if (chars(msg) > rules.messageMax) return setNotice({ kind: "error", text: `한 번에 ${rules.messageMax}자까지 말할 수 있어요.` });
    if (chars(msg) > session.left) return setNotice({ kind: "error", text: `발언권이 ${session.left}자 남았어요.` });
    // 같은 말을 다시 보내면 같은 키 (서버가 처음 결과를 돌려준다). 말을 바꾸면 새 키.
    const key = pending.current?.text === msg ? pending.current.key : newKey();
    pending.current = { text: msg, key };
    setBusy(true);
    setNotice(null);
    const optimisticId = push("me", { type: "dialogue", content: msg });
    setText("");
    setTyping(true);
    let finished = false;
    try {
      const res = await api.turn(tokenRef.current, msg, key);
      pending.current = null;
      setTyping(false);
      setMsgs((m) => m.filter((x) => x.id !== optimisticId));
      applyProgress(res);
      track("turn_sent");
      await appendExchanges(res.exchanges, true);
      finished = res.finished;
    } catch (e) {
      setTyping(false);
      setMsgs((m) => m.filter((x) => x.id !== optimisticId));
      const err = e instanceof ApiError ? e : new ApiError("unknown", "문제가 생겼어요. 다시 보내 주세요.", true);
      if (err.resync) {
        // 이미 기록된 마디가 있었다: 기록을 보여 주고, 방금 쓴 말은 입력창에 돌려준다.
        pending.current = null;
        applyProgress(err.resync);
        await appendExchanges(err.resync.exchanges, false);
        finished = err.resync.finished;
        if (!finished && err.resync.exchanges.at(-1)?.player !== msg) setText(msg);
        if (err.resync.exchanges.length > 0) setNotice({ kind: "info", text: err.message });
      } else {
        setText(msg);
        track(`error_${err.code}`);
        setNotice({ kind: "error", text: err.message, ...(err.code === "session_expired" ? { action: "restart" as const } : {}) });
      }
    }
    if (finished) {
      await wait(reduceMotion() ? 0 : 900);
      await goEnding(false);
    } else setBusy(false);
  };

  const msgLen = chars(text);
  const over = msgLen > rules.messageMax || msgLen > session.left;
  const pct = Math.max(0, (session.left / rules.charBudget) * 100);

  const noticeView = notice && (
    <div className={notice.kind === "error" ? "notice error" : "notice info"} role={notice.kind === "error" ? "alert" : "status"}>
      <p>{notice.text}</p>
      {notice.action === "restart" && (
        <button className="primary small" onClick={onRestart}>
          처음부터 다시 하기
        </button>
      )}
      {notice.action === "finish" && (
        <button className="primary small" onClick={() => void goEnding(!session.finished)}>
          결과 다시 불러오기
        </button>
      )}
    </div>
  );

  return (
    <main className="chat">
      <header className="chat-head">
        <div>
          <h1 className="chat-name">{scenario.npcName}</h1>
          <p className="chat-place">{scenario.place}</p>
        </div>
        <div className="chat-meter">
          <span className="chat-turn">
            {Math.min(session.turns + 1, rules.maxTurns)}/{rules.maxTurns}번째 말
          </span>
          <div className="budget" role="meter" aria-label="남은 발언권" aria-valuemin={0} aria-valuemax={rules.charBudget} aria-valuenow={session.left}>
            <div className="budget-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="chat-left">발언권 {session.left}자</span>
        </div>
      </header>

      <KakaoCard game={game} />

      <ol className="thread" aria-live="polite" data-clarity-unmask="true">
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
        {closing && !notice && (
          <li className="loading" role="status">
            <span className="spinner" aria-hidden="true" />
            은하 신문을 인쇄하는 중…
          </li>
        )}
      </ol>
      <div ref={endRef} className="thread-end" />

      {closing ? (
        notice && <div className="composer">{noticeView}</div>
      ) : (
        <div className="composer">
          {noticeView}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (notice?.kind === "error" && notice.action !== "restart") setNotice(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!busy) void send();
              }
            }}
            placeholder={busy ? "" : `${scenario.npcName}에게 하고 싶은 말`}
            rows={3}
            disabled={busy || notice?.action === "restart"}
            aria-label={`${scenario.npcName}에게 할 말`}
            aria-invalid={over}
          />
          <div className="composer-bar">
            <span className={`count ${over ? "over" : ""}`}>
              {msgLen}/{Math.min(rules.messageMax, session.left)}자
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
            <button className="primary small" onClick={() => void send()} disabled={busy || over || notice?.action === "restart"}>
              {pending.current && pending.current.text === text.trim() ? "다시 보내기" : "말하기"}
            </button>
          </div>
          <p className="composer-hint">한번 한 말은 고칠 수 없어요.</p>
        </div>
      )}
    </main>
  );
}
