// 말투 확인: 정해 둔 첫마디들을 실제 모델에 넣어 연인의 대답을 출력한다.
// 프롬프트(server/content.ts)를 고친 뒤 배포 전에 돌려 본다. OpenRouter 키가 필요하다 (.env 또는 .env.local).
//   npm run tone            # 윤재
//   npm run tone -- f       # 서아
import { loadEnv } from "./env.js";
loadEnv();
const { npcReply } = await import("../server/npc.js");
const { chooseMove, newGame } = await import("../server/rules.js");

const partner = process.argv[2] === "f" ? "f" : "m";
const FIRST_LINES = [
  "샤갈 윤재야 ㅇㅇ이라니 우리 그래도 연인관계야",
  "아니 바빠도 중간에 나한테 연락해줄 수 있는 거 아니야? 점심 먹을 때 잠깐 연락하는 게 어려워?",
  "너가 연락이 없을 때 뭐 하고 있을지 궁금해. 네 잠깐의 연락이 내 안식처가 된단 말이야",
  "그럼 규칙 정할까? 4시간 넘게 연락 못 한 사람이 밥 사는 거야",
  "미안 나 무시해는 내가 서운해서 감정적으로 했나 봐",
];

for (const line of FIRST_LINES) {
  const state = newGame(`tone-${Date.now()}-${Math.random()}`, Date.now(), false, partner);
  const text = partner === "f" ? line.replaceAll("윤재", "서아") : line;
  const r = await npcReply(state, text);
  console.log(`\n나: ${text}   [끝맺음: ${chooseMove(state)}]`);
  if (!r.ok) {
    console.log(`  (실패: ${r.failure.message})`);
    continue;
  }
  for (const b of r.reply.beats) console.log(b.type === "narration" ? `  *${b.content}*` : `  ${b.content}`);
  console.log(`  → +${r.reply.suggested}% | 속마음: ${r.reply.reason} | 알게 된 것: ${r.reply.noticed}`);
}
