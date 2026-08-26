import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web-workbook",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/web-workbook", emptyOutDir: true }
});
