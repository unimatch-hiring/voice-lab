import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on :5173. base is the GitHub Pages sub-path.
export default defineConfig({
  base: "/voice-lab/",
  plugins: [react()],
  test: { environment: "jsdom" },
});
