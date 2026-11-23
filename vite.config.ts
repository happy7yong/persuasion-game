import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { applyDevModelDefaults } from "./server/model-config";

// 로컬 개발에서 /api/* 를 Vercel 함수와 같은 파일로 처리한다 (vercel CLI 없이 npm run dev).
function localApi(): Plugin {
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url?.match(/^\/api\/([a-z]+)/);
        if (!m) return next();
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString("utf8");
          (req as typeof req & { body?: unknown }).body = raw ? JSON.parse(raw) : {};
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`);
          await mod.default(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // 테스트(vitest)도 이 설정을 읽는다. 그때 .env를 넣으면 API 키·Supabase가 테스트에 보여 "대본 모드" 테스트가
  // 실제 유료 호출을 하게 된다 (2026-11-23 발견). 테스트에는 .env를 넣지 않는다: 실제 호출이 필요한 테스트는 fetch를 직접 흉내 낸다
  if (!process.env.VITEST) Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  // 로컬 개발 서버(npm run dev)만 Mini가 기본이다. 배포 함수는 Vercel에서 따로 돌아 이 설정을 거치지 않는다
  if (command === "serve" && !process.env.VITEST) applyDevModelDefaults();
  return { plugins: [react(), localApi()] };
});
