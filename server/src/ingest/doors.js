// doors.js — abrir puertas y disparar relés, en las tres familias de equipo.
//
// ⚠️ ACCIÓN FÍSICA. Todo lo de acá abre puertas de verdad. Dos reglas que el
// código hace cumplir y no se negocian:
//   1. La orden la origina un OPERARIO. `openDoor()` exige `operatorId` y
//      `confirmed:true`; sin eso tira error antes de tocar la red.
//   2. NUNCA se dispara desde el contenido de un evento. No hay ningún camino
//      que vaya de un XML recibido a esta función: el ingester no la importa.
//
// LAS TRES FAMILIAS (el `kind` del dispositivo decide, no se adivina):
//
//   dsk  controladora de acceso DS-K / terminal facial
//        PUT /ISAPI/AccessControl/RemoteControl/door/<ID>
//        <RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>
//        cmd: open | close | alwaysOpen | alwaysClose
//        El <password> del manual sólo hace falta por EZVIZ Cloud; en LAN/VPN no.
//
//   ax   panel de alarma AX Pro / AX Hybrid
//        PUT /ISAPI/SecurityCP/control/outputs/<ID>?format=json
//        {"OutputsCtrl":{"switch":"open"}}
//
//   io   salida de alarma de cámara o NVR (relé cableado a la cerradura)
//        PUT /ISAPI/System/IO/outputs/<ID>/trigger
//        <IOPortData><outputState>high</outputState></IOPortData>
//        Es un NIVEL, no un pulso: para que sea pulso hay que volver a `low`
//        después de `pulseMs`. Si no, la cerradura queda liberada. Ver abajo.
//
// Fuente de los tres: catálogo ISAPI (manuales General y Person-Based Access
// Control, incorporados el 4-ago-2026).

import { digestGetBuffer, digestRequest } from "../util/digestFetch.js";

const DEFAULT_PULSE_MS = 3000;

export const DOOR_KINDS = ["dsk", "ax", "io"];

/** ¿Qué familia es este dispositivo? Explícito primero, heurística después. */
export function doorKindOf(dev = {}) {
  const k = String(dev.relayKind || dev.doorKind || "").toLowerCase();
  if (DOOR_KINDS.includes(k)) return k;
  if (k === "hik-io") return "io";            // nombre viejo, se sigue aceptando
  const t = `${dev.type || ""} ${dev.model || ""}`.toLowerCase();
  if (/ax\s*pro|axpro|axhybrid|securitycp|panel/.test(t)) return "ax";
  if (/ds-k|access|acceso|controladora/.test(t)) return "dsk";
  return "io";
}

function req(dev, { path, method = "PUT", body = "", contentType = "application/xml", timeoutMs = 6000 }) {
  return digestRequest({
    host: dev.ip || dev.camIp, port: Number(dev.isapiPort) || 80,
    https: !!dev.isapiHttps, path, method, body, contentType,
    user: dev.username, pass: dev.password || "", timeoutMs,
  });
}

/** Arma la orden sin ejecutarla. Es lo que usa `dryRun` y lo que se testea. */
export function buildOpenRequest(kind, id, cmd = "open") {
  const out = String(id);
  if (kind === "dsk") {
    const c = ["open", "close", "alwaysOpen", "alwaysClose"].includes(cmd) ? cmd : "open";
    return {
      path: `/ISAPI/AccessControl/RemoteControl/door/${out}`,
      method: "PUT", contentType: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">` +
            `<cmd>${c}</cmd></RemoteControlDoor>`,
    };
  }
  if (kind === "ax") {
    return {
      path: `/ISAPI/SecurityCP/control/outputs/${out}?format=json`,
      method: "PUT", contentType: "application/json",
      body: JSON.stringify({ OutputsCtrl: { switch: cmd === "close" ? "close" : "open" } }),
    };
  }
  return {
    path: `/ISAPI/System/IO/outputs/${out}/trigger`,
    method: "PUT", contentType: "application/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<IOPortData xmlns="http://www.isapi.org/ver20/XMLSchema">` +
          `<outputState>${cmd === "close" ? "low" : "high"}</outputState></IOPortData>`,
  };
}

/** ¿Respondió bien? El HTTP 200 no alcanza: hay que mirar el ResponseStatus. */
export function okResponse(status, text = "") {
  if (!(status >= 200 && status < 300)) return { ok: false, why: `HTTP ${status}` };
  const code = /<statusCode>\s*(\d+)\s*<\/statusCode>/i.exec(text);
  if (code && !["0", "1"].includes(code[1])) {
    const s = /<statusString>\s*([^<]*)<\/statusString>/i.exec(text);
    const sub = /<subStatusCode>\s*([^<]*)<\/subStatusCode>/i.exec(text);
    return { ok: false, why: `statusCode ${code[1]}${s ? ` (${s[1]})` : ""}${sub ? ` [${sub[1]}]` : ""}` };
  }
  try {
    const j = JSON.parse(text);
    if (j && j.statusCode != null && ![0, 1].includes(Number(j.statusCode))) {
      return { ok: false, why: `statusCode ${j.statusCode} (${j.statusString || ""})` };
    }
  } catch { /* no era JSON, ya está validado como XML */ }
  return { ok: true };
}

/**
 * Abre una puerta. **Requiere confirmación explícita de un operario.**
 *
 * @param {object} dev      dispositivo de la config de EventOS
 * @param {object} opts
 *   - output      nº de puerta / salida (default 1)
 *   - cmd         open | close | alwaysOpen | alwaysClose
 *   - operatorId  QUIÉN lo pidió — obligatorio, queda en la bitácora
 *   - confirmed   true — el operario confirmó en la UI. Obligatorio.
 *   - pulseMs     sólo `io`: a los N ms se vuelve a `low`. 0 = no volver.
 *   - dryRun      arma la orden y la devuelve SIN mandarla
 */
export async function openDoor(dev, opts = {}) {
  const {
    output = 1, cmd = "open", operatorId = null, confirmed = false,
    pulseMs = DEFAULT_PULSE_MS, dryRun = false,
  } = opts;

  if (!dev) throw new Error("no_device");
  if (!/^[\w-]+$/.test(String(output))) throw new Error("bad_output");
  if (!dryRun && !confirmed) throw new Error("not_confirmed");
  if (!dryRun && !operatorId) throw new Error("no_operator");

  const kind = doorKindOf(dev);
  const order = buildOpenRequest(kind, output, cmd);
  if (dryRun) return { dryRun: true, kind, ...order, host: dev.ip, port: dev.isapiPort };
  if (!dev.ip || !dev.username) throw new Error("no_creds");

  const r = await req(dev, order);
  const text = r.text ? String(r.text) : "";
  const v = okResponse(r.status, text);

  // Pulso: en `io` el trigger fija un NIVEL. Si nadie lo baja, la puerta queda
  // abierta para siempre. Se programa la vuelta a `low` y se reporta si falla —
  // callarse un pulso que no cerró sería dejar una puerta liberada en silencio.
  let pulse = null;
  if (v.ok && kind === "io" && pulseMs > 0 && cmd !== "close") {
    pulse = { ms: pulseMs, scheduled: true };
    setTimeout(async () => {
      try {
        const back = buildOpenRequest("io", output, "close");
        const rr = await req(dev, back);
        const vv = okResponse(rr.status, rr.text ? String(rr.text) : "");
        if (!vv.ok) console.error(`[doors] el pulso de ${dev.id}/${output} NO volvio a low: ${vv.why}`);
      } catch (e) {
        console.error(`[doors] el pulso de ${dev.id}/${output} NO volvio a low: ${e.message}`);
      }
    }, pulseMs).unref?.();
  }

  return {
    ok: v.ok, kind, output: String(output), cmd,
    status: r.status, why: v.ok ? null : v.why,
    operatorId, pulse, response: text.slice(0, 400),
  };
}

/** Salidas / puertas disponibles, para que la UI no pida un número a ciegas. */
export async function listOutputs(dev) {
  const kind = doorKindOf(dev);
  const path = kind === "dsk" ? "/ISAPI/AccessControl/RemoteControl/door/capabilities"
             : kind === "ax"  ? "/ISAPI/SecurityCP/status/outputs?format=json"
             : "/ISAPI/System/IO/outputs";
  const r = await digestGetBuffer({
    host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
    path, user: dev.username, pass: dev.password || "", timeoutMs: 6000,
  });
  const text = r.buffer ? r.buffer.toString("utf8") : "";
  if (r.status !== 200) return { kind, supported: false, status: r.status, outputs: [] };
  const ids = [...text.matchAll(/<id>\s*([\w-]+)\s*<\/id>/gi)].map((m) => m[1]);
  let json = [];
  try {
    const j = JSON.parse(text);
    const arr = j.OutputsList || j.OutputsCtrl || j.List || [];
    json = (Array.isArray(arr) ? arr : []).map((x) => String(x.id ?? x.ID ?? "")).filter(Boolean);
  } catch { /* era XML */ }
  const outputs = [...new Set([...ids, ...json])];
  return { kind, supported: true, status: r.status, outputs, raw: text.slice(0, 600) };
}

/** Estado de una salida (sólo `io` lo expone de forma directa). */
export async function outputStatus(dev, output = 1) {
  if (doorKindOf(dev) !== "io") return { supported: false };
  const r = await digestGetBuffer({
    host: dev.ip, port: Number(dev.isapiPort) || 80, https: !!dev.isapiHttps,
    path: `/ISAPI/System/IO/outputs/${output}/status`,
    user: dev.username, pass: dev.password || "", timeoutMs: 6000,
  });
  const text = r.buffer ? r.buffer.toString("utf8") : "";
  const m = /<ioState>\s*([^<]+)\s*<\/ioState>/i.exec(text);
  return { supported: r.status === 200, status: r.status, state: m ? m[1].trim() : null };
}

export default { openDoor, listOutputs, outputStatus, buildOpenRequest, doorKindOf, okResponse };
