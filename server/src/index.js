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
import { sweepEvidence } from "./evidence/retention.js";

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

  // Retencion de evidencia: limpia fotos viejas segun config (barrido horario).
  try { sweepEvidence(); const _t = setInterval(sweepEvidence, 3600000); _t.unref && _t.unref(); } catch (e) { log.warn(`retencion evidencia no arranco: ${e?.message || e}`); }

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
