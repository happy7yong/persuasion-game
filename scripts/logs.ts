// 운영 DB(Supabase)에 쌓인 다른 사람들의 플레이를 읽기 좋은 대화록(markdown)으로 뽑는다. 읽기만 한다.
// 결과는 logs/ 폴더(.gitignore 대상)에 판마다 한 파일 + 목록(index.md).
//
//   npm run logs                      # 최근 20판 (대화가 1마디 이상 있는 판만)
//   npm run logs -- --limit 100       # 최근 100판
//   npm run logs -- --since 2026-11-21
//   npm run logs -- --partner m       # 윤재만 (f = 서아)
//   npm run logs -- --id ae492c05     # 특정 판 (id 앞부분)
//   npm run logs -- --prompt          # 마디마다 모델에 들어간 프롬프트 원문도 함께
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// scripts/env.ts는 Supabase 값을 일부러 지우므로 여기서는 따로 읽는다.
for (const f of [".env", ".env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]!]) process.env[m[1]!] = m[2].replace(/^["']|["']$/g, "");
  }
}
const URL_ = process.env.SUPABASE_URL?.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 .env 또는 .env.local에 필요해요.");
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(opt("limit") ?? 20);
const since = opt("since");
const partner = opt("partner");
const idPrefix = opt("id");
const withPrompt = args.includes("--prompt");

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY!, Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Beat = { type: "narration" | "dialogue"; content: string };
interface Play {
  id: string;
  created_at: string;
  finished_at: string | null;
  heard_before: boolean | null;
  partner: string | null;
  outcome: string | null;
  final_score: number | null;
  turns_count: number | null;
  chars_used: number | null;
  belief: unknown;
  belief_feedback: string | null;
  headline: unknown;
  ending: unknown;
}
interface Turn {
  play_id: string;
  idx: number;
  created_at: string;
  player_text: string;
  npc_beats: Beat[];
  npc_move: string | null;
  noticed: string | null;
  reason: string | null;
  suggested_drop: number;
  applied_drop: number;
  labels: string[];
  score_after: number;
  model: string | null;
  elapsed_ms: number | null;
  prompt_version: string | null;
}
interface Call {
  play_id: string;
  call_type: string;
  turn_idx: number | null;
  attempt: number;
  result: string | null;
  usage: { cost?: number | null } | null;
  request: { messages?: { role: string; content: string }[] } | null;
  response_text: string | null;
}

const inList = (ids: string[]) => `in.(${ids.map((i) => `"${i}"`).join(",")})`;
const kst = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-");
const name = (p: string | null) => (p === "f" ? "서아" : "윤재");

// 1) 판 목록. 시작만 하고 한 마디도 안 한 판은 빼야 하므로 넉넉히 가져와 마디가 있는 판만 남긴다.
let q = `plays?select=*&order=created_at.desc&limit=${idPrefix ? 1000 : limit * 5}`;
if (since) q += `&created_at=gte.${since}`;
if (partner) q += `&partner=eq.${partner}`;
let plays = await get<Play[]>(q);
if (idPrefix) plays = plays.filter((p) => p.id.startsWith(idPrefix));
if (plays.length === 0) {
  console.log("조건에 맞는 판이 없어요.");
  process.exit(0);
}

const turns = await get<Turn[]>(`turns?select=*&play_id=${inList(plays.map((p) => p.id))}&order=idx.asc`);
const byPlay = new Map<string, Turn[]>();
for (const t of turns) byPlay.set(t.play_id, [...(byPlay.get(t.play_id) ?? []), t]);
plays = plays.filter((p) => byPlay.has(p.id)).slice(0, idPrefix ? undefined : limit);

const callSelect = withPrompt ? "*" : "play_id,call_type,turn_idx,attempt,result,usage,response_text";
const calls = plays.length ? await get<Call[]>(`llm_calls?select=${callSelect}&play_id=${inList(plays.map((p) => p.id))}&order=id.asc`) : [];

// 2) 판마다 markdown
mkdirSync("logs", { recursive: true });
const index: string[] = ["| 시작 (KST) | 상대 | 결과 | 마음 지수 | 마디 | 공감 피드백 | 첫 마디 | 파일 |", "|---|---|---|---|---|---|---|---|"];

for (const p of plays) {
  const ts = byPlay.get(p.id)!;
  const cs = calls.filter((c) => c.play_id === p.id);
  const cost = cs.reduce((s, c) => s + (c.usage?.cost ?? 0), 0);
  const failed = cs.filter((c) => c.result && c.result !== "ok");
  const who = name(p.partner);
  const out: string[] = [
    `# 플레이 로그 ${p.id}`,
    "",
    `- 상대: ${who} · 프롬프트 ${ts[0]?.prompt_version ?? "-"} · 모델 ${ts[0]?.model ?? "-"}`,
    `- 시작: ${kst(p.created_at)} / 종료: ${kst(p.finished_at)}`,
    `- 결과: ${p.outcome ?? "(안 끝남)"} / 최종 마음 지수: ${p.final_score ?? ts.at(-1)?.score_after} / 마디: ${ts.length} / 사용 글자: ${p.chars_used ?? "-"}`,
    `- 게임을 미리 들었나: ${p.heard_before ?? "-"} · "내가 본 너" 피드백: ${p.belief_feedback ?? "-"}`,
    `- LLM 호출 ${cs.length}회${failed.length ? ` (실패 ${failed.length}: ${failed.map((c) => c.result).join(", ")})` : ""}, 비용 $${cost.toFixed(5)}`,
    "",
    "## 대화",
  ];
  for (const t of ts) {
    out.push("", `### 마디 ${t.idx}`, "", `**나:** ${t.player_text}`, "");
    for (const b of t.npc_beats) out.push(b.type === "narration" ? `*${b.content}*` : `**${who}:** ${b.content}`, "");
    out.push(
      `> 끝맺음 ${t.npc_move ?? "-"} · 제안 하락 ${t.suggested_drop} → 확정 ${t.applied_drop}, 이후 점수 ${t.score_after} · 전략: ${t.labels.join(", ")} · ${t.elapsed_ms ?? "-"}ms`,
      `> 속마음: ${t.reason ?? "-"}`,
      `> 알게 된 것: ${t.noticed ?? "-"}`,
    );
    const tc = cs.filter((c) => c.call_type === "npc_turn" && c.turn_idx === t.idx);
    for (const c of tc.filter((c) => c.result !== "ok")) out.push("", `<details><summary>실패한 시도 #${c.attempt}: ${c.result}</summary>`, "", "```", c.response_text ?? "(응답 없음)", "```", "</details>");
    if (withPrompt) {
      const msgs = tc.find((c) => c.result === "ok")?.request?.messages ?? tc[0]?.request?.messages ?? [];
      for (const m of msgs) out.push("", `<details><summary>프롬프트 · ${m.role}</summary>`, "", "```", m.content, "```", "</details>");
    }
  }
  for (const [title, v] of [["내가 본 너", p.belief], ["은하 신문", p.headline], ["엔딩 리포트", p.ending]] as const) {
    if (v) out.push("", `## ${title}`, "", "```json", JSON.stringify(v, null, 2), "```");
  }
  const file = `play-${p.id.slice(0, 8)}.md`;
  writeFileSync(`logs/${file}`, out.join("\n") + "\n");
  const first = ts[0]!.player_text.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 40);
  index.push(`| ${kst(p.created_at)} | ${who} | ${p.outcome ?? "-"} | ${p.final_score ?? ts.at(-1)?.score_after} | ${ts.length} | ${p.belief_feedback ?? "-"} | ${first} | [${file}](${file}) |`);
}

if (!idPrefix) writeFileSync("logs/index.md", `# 최근 플레이 ${plays.length}판\n\n${index.join("\n")}\n`);
console.log(`${plays.length}판을 logs/에 저장했어요.${idPrefix ? "" : " 목록: logs/index.md"}`);
