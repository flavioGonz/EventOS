// Corre con:  node tests/access-doors.test.mjs   (desde la raiz del repo)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const R = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.EVENTOS_ACCESS_TYPES_FILE = resolve(R, "server/data/access-event-types.json");
const A = await import(resolve(R, "server/src/events/access.js"));
const D = await import(resolve(R, "server/src/ingest/doors.js"));
let fail = 0;
const t = (name, cond, extra="") => { if (!cond) { fail++; console.log("FALLA  " + name + "  " + extra); } else console.log("ok     " + name); };

// --- 1. JSON del push httpHosts (AX / DS-K) ---
const j = { ipAddress:"192.168.7.60", dateTime:"2026-08-04T11:00:00-03:00",
  AccessControllerEvent:{ majorEventType:5, subEventType:28, doorNo:2, deviceName:"Panel Portón", serialNo:"AX-001" } };
let r = A.accessFields(j, { site:"Cesimco" });
t("JSON puerta fuera de tiempo -> door_held", r.type === "door_held", r.type);
t("JSON pointKind door / id 2", r.fields.pointKind==="door" && String(r.fields.pointId)==="2");
t("JSON hex del manual", r.fields.hik === "0x1c", r.fields.hik);

// --- 2. XML (alertStream local) ---
const xml = `<EventNotificationAlert><ipAddress>192.168.7.60</ipAddress><dateTime>2026-08-04T11:00:00-03:00</dateTime>
<AccessControllerEvent><majorEventType>5</majorEventType><subEventType>27</subEventType><doorNo>1</doorNo>
<cardNo>1234</cardNo><name>Juan Perez</name></AccessControllerEvent></EventNotificationAlert>`;
r = A.accessFields(xml, {});
t("XML puerta forzada -> door_forced", r.type === "door_forced", r.type);
t("XML mensaje con persona", /Juan Perez/.test(r.fields.message), r.fields.message);

// --- 3. ECO de nuestra propia apertura: NO debe generar evento ---
r = A.accessFields({ AccessControllerEvent:{ majorEventType:3, subEventType:1024, doorNo:1 } });
t("eco de apertura remota se descarta", r === null);

// --- 4. codigo desconocido: se procesa igual, como system ---
r = A.accessFields({ AccessControllerEvent:{ majorEventType:2, subEventType:1111, doorNo:1 } });
t("codigo raro no se pierde", r !== null && r.type === "system" && r.known === false, JSON.stringify(r&&r.fields?.eventLabel));

// --- 5. ordenes de apertura, sin tocar la red ---
const ord = {
  dsk: D.buildOpenRequest("dsk", 2, "open"),
  ax:  D.buildOpenRequest("ax", 3),
  io:  D.buildOpenRequest("io", 1),
};
t("DS-K path", ord.dsk.path === "/ISAPI/AccessControl/RemoteControl/door/2", ord.dsk.path);
t("DS-K body cmd open", /<cmd>open<\/cmd>/.test(ord.dsk.body));
t("AX path json", ord.ax.path === "/ISAPI/SecurityCP/control/outputs/3?format=json", ord.ax.path);
t("AX body switch open", JSON.parse(ord.ax.body).OutputsCtrl.switch === "open");
t("IO path trigger", ord.io.path === "/ISAPI/System/IO/outputs/1/trigger", ord.io.path);
t("IO body high", /<outputState>high<\/outputState>/.test(ord.io.body));
t("IO cierre baja a low", /<outputState>low<\/outputState>/.test(D.buildOpenRequest("io",1,"close").body));

// --- 6. familia detectada ---
t("kind explicito ax", D.doorKindOf({relayKind:"ax"}) === "ax");
t("kind viejo hik-io -> io", D.doorKindOf({relayKind:"hik-io"}) === "io");
t("kind por modelo DS-K", D.doorKindOf({model:"DS-K2604"}) === "dsk");
t("kind por defecto io", D.doorKindOf({}) === "io");

// --- 7. la confirmacion del operario es obligatoria ---
let err = null;
try { await D.openDoor({ip:"1.2.3.4",username:"a"}, { output:1 }); } catch(e){ err = e.message; }
t("sin confirmar NO abre", err === "not_confirmed", String(err));
err = null;
try { await D.openDoor({ip:"1.2.3.4",username:"a"}, { output:1, confirmed:true }); } catch(e){ err = e.message; }
t("sin operario NO abre", err === "no_operator", String(err));
const dry = await D.openDoor({ip:"1.2.3.4",isapiPort:80,relayKind:"dsk"}, { output:5, dryRun:true });
t("dryRun no manda nada y devuelve la orden", dry.dryRun === true && dry.path.endsWith("/door/5"), dry.path);

// --- 8. el HTTP 200 no alcanza ---
t("200 con statusCode 4 es FALLA", D.okResponse(200, "<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString></ResponseStatus>").ok === false);
t("200 con statusCode 1 es OK", D.okResponse(200, "<ResponseStatus><statusCode>1</statusCode></ResponseStatus>").ok === true);
t("200 con JSON statusCode 4 es FALLA", D.okResponse(200, '{"statusCode":4,"statusString":"Invalid Operation"}').ok === false);
t("401 es FALLA", D.okResponse(401, "").ok === false);

console.log(fail ? `\n${fail} FALLAS` : "\nlos " + 23 + " casos pasan");
process.exit(fail ? 1 : 0);
