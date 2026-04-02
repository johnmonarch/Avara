import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const allowedHosts = Array.from(
  new Set(
    [".dogeroku.com", process.env.AVARA_ALLOWED_HOSTS ?? process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? ""]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  )
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    allowedHosts
  },
  preview: {
    allowedHosts
  }
});
