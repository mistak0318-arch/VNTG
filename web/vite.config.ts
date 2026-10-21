import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // IPv4로 명시 바인딩. host:true는 Windows에서 IPv6(::)에만 물려
    // 폰이 192.168.x.x(IPv4)로 접속할 때 실패하는 경우가 있다.
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        /*
         * **장중에는 미니PC 로 보낼 수 있다** (2026-10-21).
         *
         * 로컬 서버를 띄우면 그 서버가 **따로** 키움을 긁는다 — 미니PC 와 같은 앱키라
         * 조회 한도를 둘이 나눠 쓰게 되고, 장중에는 그게 곧 느려짐이다(실측 기록 있음).
         * 화면만 보고 싶을 때는 API 를 이미 돌고 있는 쪽으로 보낸다:
         *
         *     VNTG_API=http://100.88.182.35:4000 npm run dev
         *
         * 안 주면 여태처럼 로컬 4000 이다 — 서버 코드를 고칠 때는 그게 맞다.
         */
        target: process.env.VNTG_API ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
