import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on :5173. base — подпуть GitHub Pages (см. Task 16).
export default defineConfig({
  base: "/voice-lab/",
  plugins: [react()],
  test: { environment: "jsdom" },
});
