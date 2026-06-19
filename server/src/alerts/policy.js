// policy.js — política de alertado POR DISPOSITIVO. Decide si un evento de una
// cámara genera alerta al operador según `device.alerts`:
//   { enabled, types:{<tipo>:bool}, target:'any|human|vehicle|human_vehicle',
//     priority:1..5|null, schedule:{ mode:'always|window', days:[0..6], from, to } }
// Sin config (device.alerts ausente) → alerta TODO (compatibilidad).
const TZ = "America/Montevideo"; // cesimco (Uruguay, UTC-3)

function nowParts() {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // Intl con hour12:false devuelve "24" a la medianoche → normalizar a 0.
    const h = Number(p.hour) % 24;
    return { day: dayMap[p.weekday] ?? new Date().getDay(), minutes: h * 60 + Number(p.minute) };
  } catch {
    const d = new Date();
    return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
  }
}

function toMin(s) { const [h, m] = String(s || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); }

function inWindow(sch) {
  if (!sch || sch.mode !== "window") return true; // 'always' o sin schedule → activo
  const { day, minutes } = nowParts();
  const days = Array.isArray(sch.days) && sch.days.length ? sch.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(day)) return false;
  const from = toMin(sch.from || "00:00"), to = toMin(sch.to || "23:59");
  if (from <= to) return minutes >= from && minutes <= to;
  return minutes >= from || minutes <= to; // ventana que cruza medianoche (p.ej. 20:00→08:00)
}

// Devuelve { allow, reason?, priority? }. priority (si vino) sobreescribe.
export function evaluateDeviceAlert(device, event) {
  const a = device && device.alerts;
  if (!a) return { allow: true };
  if (a.enabled === false) return { allow: false, reason: "device_alerts_off" };

  if (a.types && typeof a.types === "object") {
    if (a.types[event.type] === false) return { allow: false, reason: "type_disabled" };
  }

  if (a.target && a.target !== "any") {
    const tg = event.target;
    const ok =
      a.target === "human" ? tg === "human" :
      a.target === "vehicle" ? tg === "vehicle" :
      a.target === "human_vehicle" ? (tg === "human" || tg === "vehicle") : true;
    if (!ok) return { allow: false, reason: "target_filter" };
  }

  if (!inWindow(a.schedule)) return { allow: false, reason: "out_of_schedule" };

  const pr = Number(a.priority);
  return { allow: true, priority: pr >= 1 && pr <= 5 ? pr : undefined };
}

export default { evaluateDeviceAlert };
