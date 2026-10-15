import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev the API runs on its own port, separate from PORT (which tools like the preview pane may set).
const apiPort = process.env.API_PORT ?? "8787";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
});
