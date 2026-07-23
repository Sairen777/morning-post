import { defineConfig } from "@solidjs/start/config";

// Vinxi's outer listener reads HOST; Vite's nested server host does not control it.
process.env.HOST ??= "127.0.0.1";
const webPort = Number(process.env.WEB_PORT ?? "5173");
if (!Number.isInteger(webPort) || webPort <= 0 || webPort > 65_535) {
  throw new Error("WEB_PORT must be a valid TCP port");
}
const backendOrigin = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  ssr: false,
  server: {
    prerender: {
      crawlLinks: false,
      routes: ["/"],
    },
  },
  vite: {
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/auth": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/sources": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/feeds": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/interests": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/digests": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/stories": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/connectors": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
        "/health": {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  },
});
