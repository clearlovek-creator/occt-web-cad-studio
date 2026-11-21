import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function canWriteDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = fs.mkdtempSync(path.join(directory, ".write-check-"));
    fs.rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveWritableDataDir(configuredDir, { allowTemporaryFallback = false, fallbackRoot = os.tmpdir(), onFallback = () => {} } = {}) {
  const configured = path.resolve(configuredDir);
  if (canWriteDirectory(configured)) return configured;
  if (!allowTemporaryFallback) throw new Error(`Geometry data directory is not writable: ${configured}. Fix its permissions or explicitly configure GEOMETRY_DATA_DIR. Temporary fallback is disabled to protect project persistence.`);
  const fallback = path.join(fallbackRoot, "occt-web-cad-demo-data");
  if (!canWriteDirectory(fallback)) throw new Error(`Geometry data directory is not writable: ${configured}`);
  onFallback({ configured, fallback });
  return fallback;
}
