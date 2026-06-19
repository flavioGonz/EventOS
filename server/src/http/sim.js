// sim.js — /api/sim/* (CONTRACT §3): burst, start, stop
import { Router } from "express";
import { log } from "../logger.js";
import * as gen from "../simulator/gen.js";
import { ingestRaw } from "../dispatch/pipeline.js";

const router = Router();

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
