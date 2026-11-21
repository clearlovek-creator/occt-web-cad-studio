import fs from "node:fs";
import path from "node:path";

const target = path.resolve("node_modules", ".vite-temp");
try {
  fs.rmSync(target, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== "ENOENT") process.stderr.write("[build] Could not clear Vite temp cache: " + error.message + "\n");
}