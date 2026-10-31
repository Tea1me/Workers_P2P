import { defineConfig } from "vite";
export default defineConfig({
  root: "tests/browser",
  build: {
    outDir: "../../.browser-tests",
    emptyOutDir: true,
    target: "es2022",
  },
});
