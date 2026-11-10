import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const port = process.env.PORT ?? loadEnv(mode, root, "PORT").PORT ?? "8787";
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
    },
  };
});
