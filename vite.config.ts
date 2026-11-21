import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return { plugins: [react(), localApi()] };
});
