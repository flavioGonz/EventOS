// index.js — arranque: express + http + socket.io (CONTRACT §8)
import http from "node:http";
import express from "express";
import cors from "cors";
import { Server as SocketServer } from "socket.io";

import { config } from "./config.js";
import { log } from "./logger.js";
import { bus } from "./bus/redisBus.js";
import { attachConsole } from "./socket/console.js";
import { load as loadConfigStore } from "./config/store.js";
import { startAlertStreams } from "./ingest/alertStream.js";
import { startPanelIngest } from "./ingest/panels.js";
import { sweepEvidence } from "./evidence/retention.js";
import { startHealthSampler } from "./health/history.js";
import { startStatusSampler } from "./health/status.js";
import { initDb, migrate } from "./db/pg.js";
import { backfillPg, hydrateFromPg } from "./dispatch/store.js";
import { loadFromPg as loadConfigFromPg } from "./config/store.js";
import { hydrateSessions } from "./auth/session.js";

import apiRouter from "./http/api.js";
import ingestRouter from "./http/ingest.js";
import simRouter from "./http/sim.js";
import adminRouter from "./http/admin.js";

async function main() {
  // Carga (o siembra) el almacén de configuración persistente. No tira el server.
  loadConfigStore();

  // Inicializa el bus (Redis o fallback memoria). No tira si Redis está caído.
  await bus.init();

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "2mb" }));
  // Webhooks Hikvision: el dispositivo postea EventNotificationAlert como XML
  // (application/xml, text/xml), a veces text/plain, y a menudo multipart/form-data
  // (una parte XML + un JPEG opcional). Aceptamos todos esos content-types como TEXTO
  // crudo → req.body queda como string y el normalizador lo parsea (XML/multipart).
  app.use(
    express.text({
      type: ["text/*", "application/xml", "multipart/*"],
      limit: "8mb",
      // Guarda el buffer CRUDO fiel (bytes intactos) sin alterar el parseo: lo usa
      // el volcado de ingesta para inspeccionar el JPEG real del multipart.
      verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); },
    })
  );
  // Red de seguridad: cualquier otro content-type no-JSON (p.ej. application/octet-stream)
  // se captura como buffer y se convierte a string, para no perder el payload Hik.
  app.use(
    express.raw({
      type: (req) => {
        const ct = req.headers["content-type"] || "";
        return !/json|text\/|xml|multipart\//i.test(ct);
      },
      limit: "8mb",
    })
  );
  app.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) req.body = req.body.toString("utf8");
    next();
  });

  // Routers (admin antes que el catch-all; /api genérico va último por especificidad)
  app.use("/api/admin", adminRouter);
  app.use("/api/ingest", ingestRouter);
  app.use("/api/sim", simRouter);
  app.use("/api", apiRouter);

  app.get("/", (req, res) => res.json({ service: "eventos-server", ok: true }));

  // 404 JSON
  app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));

  // Servidor HTTP + Socket.io
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: config.corsOrigin, methods: ["GET", "POST"] },
  });
  attachConsole(io);

  server.listen(config.port, config.host, () => {
    log.info("──────────────────────────────────────────────");
    log.info(" EventOS server");
    log.info(`  escuchando en   http://${config.host}:${config.port}`);
    log.info(`  bus             ${bus.mode()}`);
    log.info(`  cors origin     ${config.corsOrigin}`);
    log.info(`  ingest token    ${config.ingestToken}`);
    log.info(`  admin token     ${config.adminToken || "(abierto / dev)"}`);
    log.info("──────────────────────────────────────────────");
  });

  // Recepción de eventos en tiempo real desde los NVR (Hikvision alertStream).
  // Opt-in por EVENTOS_ALERTSTREAM=1. Nunca tira el server.
  try { startAlertStreams(); } catch (e) { log.warn(`alertStream no arrancó: ${e?.message || e}`); }
  // Paneles de alarma AX y controladoras DS-K. Va detras de EVENTOS_PANELS=1
  // y en un try aparte: si un panel esta mal configurado, no puede tumbar la
  // recepcion de las camaras, que es lo que hoy sostiene la operacion.
  try { startPanelIngest(); } catch (e) { log.warn(`panels no arrancó: ${e?.message || e}`); }

  // Retencion de evidencia: limpia fotos viejas segun config (barrido horario).
  try { sweepEvidence(); const _t = setInterval(sweepEvidence, 3600000); _t.unref && _t.unref(); } catch (e) { log.warn(`retencion evidencia no arranco: ${e?.message || e}`); }

  // Histórico de salud de NVR: muestreo periódico persistido (para la gráfica comparativa).
  try { startHealthSampler(); } catch (e) { log.warn(`health sampler no arrancó: ${e?.message || e}`); }
  try { startStatusSampler(); } catch (e) { log.warn(`status sampler no arrancó: ${e?.message || e}`); }

  // PostgreSQL (migración incremental de datos): crea el esquema y vuelca a la DB los
  // eventos ya existentes en memoria/JSON. Tolerante: si PG no está o falla, el server
  // sigue funcionando con el estado en memoria/JSON (write-through best-effort en vivo).
  ;(async () => {
    try {
      if (initDb()) {
        await migrate();
        await loadConfigFromPg();               // inventario: carga desde PG o backfill JSON→PG
        const n = await backfillPg();           // eventos: vuelca los que ya están en memoria → PG
        log.info(`PG: backfill de ${n} eventos existentes → Postgres`);
        const h = await hydrateFromPg();        // eventos: rehidrata la cola en vivo desde PG
        if (h && h.pg) log.info(`PG: cola hidratada desde Postgres → ${h.active} activos, ${h.resolved} resueltos (agregados: ${h.added} act / ${h.addedRes} res)`);
        const ns = await hydrateSessions();     // sesiones: rehidrata las vigentes desde PG
        log.info(`PG: sesiones rehidratadas desde Postgres → ${ns} vigentes`);
      }
    } catch (e) { log.warn(`PG setup no completó: ${e?.message || e}`); }
  })();

  // Apagado limpio
  const shutdown = (sig) => {
    log.info(`Recibido ${sig}, cerrando…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e?.message || e));
  process.on("uncaughtException", (e) => log.error("uncaughtException:", e?.message || e));
}

main().catch((e) => {
  log.error("Fallo al arrancar:", e?.message || e);
  process.exit(1);
});
