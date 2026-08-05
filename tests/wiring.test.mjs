// Corre con:  node tests/wiring.test.mjs   (desde la raiz del repo)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const R = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.EVENTOS_ACCESS_TYPES_FILE = resolve(R, "server/data/access-event-types.json");
const N = await import(resolve(R, "server/src/events/normalize.js"));
const C = await import(resolve(R, "server/src/events/catalog.js"));
const P = await import(resolve(R, "server/src/ingest/panels.js")).catch(e=>({_err:e.message}));
let fail=0; const t=(n,c,x="")=>{ if(!c){fail++;console.log("FALLA  "+n+"  "+x);} else console.log("ok     "+n); };

t("catalog tiene access_granted", !!C.CATALOG.access_granted, JSON.stringify(Object.keys(C.CATALOG).slice(-3)));
t("access registrado en normalizers", typeof N.normalizers.access === "function");

const ev = N.normalize("access",
  { AccessControllerEvent:{ majorEventType:5, subEventType:28, doorNo:2 } },
  { deviceId:"panel-1", deviceName:"Panel Porton", site:"Cesimco", ip:"192.168.7.60" });
t("evento construido", ev && ev.id && ev.type==="door_held", ev && ev.type);
t("ctx del ingester llega a source", ev.source.deviceId==="panel-1" && ev.source.site==="Cesimco", JSON.stringify(ev.source));
t("titulo del catalogo", ev.title==="Puerta mantenida abierta", ev.title);
t("prioridad de door_held", ev.priority===3, String(ev.priority));
t("mensaje legible", /fuera de tiempo/i.test(ev.message||""), ev.message);

const eco = N.normalize("access", { AccessControllerEvent:{ majorEventType:3, subEventType:1024, doorNo:1 } }, {});
t("eco -> null desde normalize()", eco === null);

const g = N.normalize("access", { AccessControllerEvent:{ majorEventType:5, subEventType:25, doorNo:1 } }, {});
t("apertura por contacto -> access_granted", g.type==="access_granted" && g.title==="Acceso concedido", g.type+"/"+g.title);

// normalizadores viejos: el 2do argumento no los rompe
const h = N.normalize("hikvision", { eventType:"linedetection", channelID:"6", detectionTarget:"human" }, {foo:1});
t("normalizer viejo sigue andando", h && h.type==="line_crossing", h && h.type);

// panels.js
t("panels.js importa", !P._err, P._err||"");
if (!P._err) {
  const a = P.splitAlerts("ruido<EventNotificationAlert><a/></EventNotificationAlert>mas<EventNotificationAlert><b/></EventNotificationAlert>cola");
  t("splitAlerts separa 2 alertas", a.length===2, String(a.length));
  const d = await P.configureHttpHost({ip:"1.2.3.4"}, "http://172.26.20.247:4010/api/ingest/access?token=X", {dryRun:true});
  t("httpHosts dryRun arma el PUT", d.path==="/ISAPI/Event/notification/httpHosts/1" && /<ipAddress>172.26.20.247<\/ipAddress>/.test(d.body), d.path);
  t("httpHosts manda el puerto", /<portNo>4010<\/portNo>/.test(d.body));
  t("httpHosts manda la ruta", /<url>\/api\/ingest\/access\?token=X<\/url>/.test(d.body));
}
console.log(fail?`\n${fail} FALLAS`:"\ntodo ok");
process.exit(fail?1:0);
