import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./app", import.meta.url)) } },
  // OPENRECORD_API_URL lets a second local stack (another worktree) run beside the default one.
  server: { port: 3000, proxy: { "/api": process.env["OPENRECORD_API_URL"] ?? "http://localhost:3001" } },
})
