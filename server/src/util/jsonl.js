// jsonl.js — utilidades de append/lectura de archivos JSONL bajo server/data.
//
// Pensado para los logs de auditoría/analítica (operator-log.jsonl, events.jsonl):
//  - appendJsonl: escritura asíncrona, NUNCA lanza (tolerante a fallo de IO).
//  - readJsonl: lectura síncrona tolerante; archivo ausente → [].
//  - capFile: recorte barato del archivo si supera un tamaño máximo (mantiene la cola).
//
// Sólo stdlib (fs). No bloquea el hot-path: los appends usan fs.appendFile (async).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/util → server/data
export const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

// Resuelve un nombre de archivo a su ruta absoluta dentro de server/data.
export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

// Garantiza que exista el directorio de datos (no lanza).
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* tolerante: si no se puede crear, el append fallará silenciosamente */
  }
}

// Append asíncrono de un objeto como una línea JSON. Nunca lanza.
// Devuelve una promesa que siempre resuelve (errores se loguean, no propagan).
export function appendJsonl(name, obj) {
  return new Promise((resolve) => {
    let line;
    try {
      line = JSON.stringify(obj) + "\n";
    } catch (e) {
      log.warn(`appendJsonl: no se pudo serializar (${e.message})`);
      return resolve(false);
    }
    ensureDataDir();
    fs.appendFile(dataPath(name), line, "utf8", (err) => {
      if (err) log.warn(`appendJsonl(${name}) falló: ${err.message}`);
      resolve(!err);
    });
  });
}

// Lee un JSONL y devuelve un array de objetos parseados. Tolerante:
//  - archivo ausente → []
//  - líneas corruptas → se ignoran
// Síncrono (lo usan los endpoints admin, fuera del hot-path).
export function readJsonl(name) {
  let txt;
  try {
    txt = fs.readFileSync(dataPath(name), "utf8");
  } catch {
    return []; // ausente o inaccesible
  }
  const out = [];
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* línea corrupta: ignorar */
    }
  }
  return out;
}

// Recorta el archivo si supera maxBytes, manteniendo aproximadamente la última
// mitad (la cola más reciente). Barato: lee el tamaño y, si excede, reescribe
// sólo la cola. Asíncrono y tolerante; nunca lanza.
export function capFile(name, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve) => {
    const file = dataPath(name);
    fs.stat(file, (statErr, st) => {
      if (statErr || !st || st.size <= maxBytes) return resolve(false);
      // Leer todo, quedarnos con la cola (~50% del máximo) alineada a línea.
      fs.readFile(file, "utf8", (readErr, txt) => {
        if (readErr || typeof txt !== "string") return resolve(false);
        const keep = Math.floor(maxBytes / 2);
        let tail = txt.length > keep ? txt.slice(txt.length - keep) : txt;
        // Alinear a comienzo de línea (descartar la primera línea parcial).
        const nl = tail.indexOf("\n");
        if (nl >= 0) tail = tail.slice(nl + 1);
        const tmp = file + ".tmp";
        fs.writeFile(tmp, tail, "utf8", (wErr) => {
          if (wErr) {
            log.warn(`capFile(${name}) write falló: ${wErr.message}`);
            return resolve(false);
          }
          fs.rename(tmp, file, (rErr) => {
            if (rErr) {
              log.warn(`capFile(${name}) rename falló: ${rErr.message}`);
              try { fs.unlink(tmp, () => {}); } catch {}
              return resolve(false);
            }
            resolve(true);
          });
        });
      });
    });
  });
}

export default { appendJsonl, readJsonl, capFile, dataPath, DATA_DIR };
