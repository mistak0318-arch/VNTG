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
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
