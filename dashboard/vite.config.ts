import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built to static files that Tilll serves itself at /dashboard (one container, no second server).
export default defineConfig({
  root: "dashboard",
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../public/dashboard", emptyOutDir: true },
});
