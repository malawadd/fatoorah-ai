import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(here, "..", "..", ".env"),
  path.resolve(here, "..", "..", "..", ".env")
];

for (const filePath of Array.from(new Set(candidates))) {
  if (existsSync(filePath)) {
    config({ path: filePath, override: false, quiet: true });
  }
}
