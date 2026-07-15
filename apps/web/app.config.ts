import { defineConfig } from "@solidjs/start/config";

// Vinxi's outer listener reads HOST; Vite's nested server host does not control it.
process.env.HOST ??= "127.0.0.1";

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
      port: 5173,
      strictPort: true,
      proxy: {
        "/auth": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
        "/sources": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
        "/feeds": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
        "/digests": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
        "/connectors": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
        "/health": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  },
});
