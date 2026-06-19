// retention.js — barrido de evidencia (galería por caso). Borra fotos viejas
// segun config (evidence.retentionDays) y limita el total (evidence.maxFiles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEvidence } from "../config/store.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "data", "evidence");

export function sweepEvidence() {
  try {
    if (!fs.existsSync(EVIDENCE_DIR)) return { deleted: 0 };
    const { retentionDays, maxFiles } = getEvidence();
    let files = fs.readdirSync(EVIDENCE_DIR).filter((f) => /\.jpg$/i.test(f))
      .map((f) => { const fp = path.join(EVIDENCE_DIR, f); try { return { fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; } })
      .filter(Boolean);
    let deleted = 0;
    const days = Number(retentionDays) || 0;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      files = files.filter((it) => { if (it.mtime < cutoff) { try { fs.unlinkSync(it.fp); deleted++; } catch {} return false; } return true; });
    }
    const cap = Number(maxFiles) || 0;
    if (cap > 0 && files.length > cap) {
      files.sort((a, b) => a.mtime - b.mtime);
      const over = files.length - cap;
      for (let i = 0; i < over; i++) { try { fs.unlinkSync(files[i].fp); deleted++; } catch {} }
    }
    if (deleted) log.info(`retencion de evidencia: ${deleted} archivo(s) eliminado(s)`);
    return { deleted };
  } catch (e) { log.warn(`sweepEvidence: ${e?.message || e}`); return { deleted: 0, error: String(e?.message || e) }; }
}
export default sweepEvidence;
