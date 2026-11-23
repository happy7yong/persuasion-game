// 스크립트용: .env / .env.local을 읽어 process.env에 넣는다 (이미 있는 값은 덮어쓰지 않는다).
// 저장소(Supabase) 값은 지워서, 터미널 테스트가 실제 데이터에 섞이지 않게 한다.
import { existsSync, readFileSync } from "node:fs";
import { applyDevModelDefaults } from "../server/model-config.js";

export function loadEnv(): void {
  for (const f of [".env", ".env.local"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !process.env[m[1]!]) process.env[m[1]!] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  // 개발·평가는 Mini가 기본이다 (모델 환경 변수가 비어 있을 때만)
  applyDevModelDefaults();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("\x1b[2mOPENROUTER_API_KEY가 없어 대본 모드로 실행해요. 실제 말투를 보려면 .env 또는 .env.local에 키를 넣어 주세요.\x1b[0m");
  }
}
