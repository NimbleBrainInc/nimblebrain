import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: process.env.NB_WEB_PORT ? Number(process.env.NB_WEB_PORT) : 27246,
    proxy: {
      "/v1": {
        target: `http://localhost:${process.env.NB_API_PORT ?? 27247}`,
        changeOrigin: true,
      },
    },
  },
});
