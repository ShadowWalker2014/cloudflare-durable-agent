import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// agents() compiles the @callable() decorators; cloudflare() runs the Worker
// and its Durable Objects inside workerd during `vite dev`.
export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Pre-bundle these up front so the first page load never hits "Outdated Optimize Dep".
  optimizeDeps: { include: ["radix-ui", "motion/react", "lucide-react", "streamdown", "use-stick-to-bottom", "cmdk"] }
});
