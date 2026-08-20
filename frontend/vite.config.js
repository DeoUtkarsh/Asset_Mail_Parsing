import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.io"],
    proxy: {
      "/api/events": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        timeout: 25000,
        proxyTimeout: 25000,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.error("[vite proxy]", err.message);
            if (res && !res.headersSent && typeof res.writeHead === "function") {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ detail: "Backend unavailable. Wait for uvicorn, then refresh." }));
            }
          });
        },
      },
    },
  },
});
