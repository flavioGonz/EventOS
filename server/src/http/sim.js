// sim.js — /api/sim/* (CONTRACT §3): burst, start, stop
import { Router } from "express";
import { log } from "../logger.js";
import * as gen from "../simulator/gen.js";
import { ingestRaw } from "../dispatch/pipeline.js";
import { sessionFromReq } from "../auth/session.js";
import { config, tokensEqual } from "../config.js";

const router = Router();

// El simulador inyecta tráfico real por el pipeline (y castiga los NVR con
// snapshots), así que en producción queda cerrado: sólo sesión admin o
// X-Admin-Token válido. Se abre con EVENTOS_SIM=1 (entornos de demo).
router.use((req, res, next) => {
  if (process.env.EVENTOS_SIM === "1") return next();
  const s = sessionFromReq(req);
  if (s && s.role === "admin") return next();
  if (config.adminToken && tokensEqual(req.get("X-Admin-Token"), config.adminToken)) return next();
  return res.status(403).json({ error: "sim_disabled", message: "Simulador restringido a admin" });
});

// Procesa un payload crudo del generador a través del pipeline
async function feed(raw) {
  try {
    await ingestRaw(raw.vendor, raw.raw);
  } catch (err) {
    log.warn(`sim feed error: ${err.message}`);
  }
}

// Genera N eventos aleatorios de inmediato
router.post("/burst", async (req, res) => {
  const count = req.body?.count ?? 5;
  const batch = gen.burst(count);
  const events = [];
  for (const raw of batch) {
    try {
      events.push(await ingestRaw(raw.vendor, raw.raw));
    } catch (err) {
      log.warn(`sim burst error: ${err.message}`);
    }
  }
  log.info(`Simulador burst: ${events.length} eventos generados`);
  res.status(201).json({ count: events.length, events });
});

// Arranca flujo continuo
router.post("/start", (req, res) => {
  const everyMs = req.body?.everyMs ?? 4000;
  const state = gen.start(everyMs, feed);
  log.info(`Simulador iniciado: cada ${state.everyMs}ms`);
  res.json({ ...state });
});

// Detiene el flujo continuo
router.post("/stop", (req, res) => {
  const state = gen.stop();
  log.info("Simulador detenido");
  res.json({ ...state });
});

export default router;
