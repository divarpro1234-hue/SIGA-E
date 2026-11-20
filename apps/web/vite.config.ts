import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const NONCE_DESARROLLO = "desarrollo-no-es-secreto";
const CSP_DESARROLLO =
  `default-src 'none'; script-src 'self' 'nonce-${NONCE_DESARROLLO}'; style-src 'self' 'nonce-${NONCE_DESARROLLO}'; img-src 'self'; font-src 'self'; ` +
  "connect-src 'self' wss://127.0.0.1:5173; manifest-src 'self'; worker-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const sinServiceWorkerEnDesarrollo: Plugin = {
  name: "siga-e-dev-service-worker",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/sw.js") {
        next();
        return;
      }

      response.statusCode = 404;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end("Service workers are disabled in development.");
    });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [sinServiceWorkerEnDesarrollo, react()],
  html: command === "serve" ? { cspNonce: NONCE_DESARROLLO } : {},
  server: {
    ...(command === "serve" ? {
      https: {
        key: readFileSync("D:/Herramientas/mkcert/certs/siga-e/localhost-key.pem"),
        cert: readFileSync("D:/Herramientas/mkcert/certs/siga-e/localhost.pem"),
      },
    } : {}),
    ws: { protocol: "wss", host: "127.0.0.1", clientPort: 5173 },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    headers: { "Content-Security-Policy": CSP_DESARROLLO },
    proxy: {
      "/api/v1": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
}));
