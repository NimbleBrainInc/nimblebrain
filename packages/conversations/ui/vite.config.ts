import { synapseVite } from "@nimblebrain/synapse/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile(), synapseVite()],
  build: { outDir: "dist", assetsInlineLimit: Infinity },
});
