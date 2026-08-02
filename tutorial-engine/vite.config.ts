import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  // Relative asset URLs so the built app can be served from any mount path.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true
  }
});
