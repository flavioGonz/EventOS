#!/usr/bin/env node
// seed-auth.mjs — asegura credenciales de login (usuario+contraseña) en el
// almacén de configuración. Idempotente: sólo crea/actualiza lo que falta.
//
//   node server/scripts/seed-auth.mjs                 # crea faltantes, no pisa
//   node server/scripts/seed-auth.mjs --reset-pass    # regenera TODAS las claves
//
// Imprime las credenciales generadas al final (para entregarlas UNA vez).
import { randomBytes } from "node:crypto";
import * as store from "../src/config/store.js";

const RESET = process.argv.includes("--reset-pass");

// Contraseña legible: 3 grupos de 4 (letras sin ambiguas + dígitos).
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
function genPass() {
  const b = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += ALPHA[b[i] % ALPHA.length];
  }
  return s; // p.ej. k7pq-m3ra-tx9d
}

store.load();
const ops = store.list("operators");
const byUser = (u) => ops.find((o) => (o.username || "").toLowerCase() === u);
const byName = (n) => ops.find((o) => (o.name || "").toLowerCase() === n.toLowerCase());

const created = []; // {username, password, role, name}

// 1) Roles base: admin, supervisor, operador (uno de cada). Se crean si faltan.
const BASE = [
  { username: "admin", name: "Administrador", role: "admin", skills: ["video", "access", "intrusion", "system"] },
  { username: "supervisor", name: "Supervisor", role: "supervisor", skills: ["video", "access", "intrusion", "system"] },
  { username: "operador", name: "Operador", role: "agente", skills: ["video", "access", "intrusion"] },
];
for (const b of BASE) {
  let op = byUser(b.username);
  if (!op) {
    const pass = genPass();
    op = store.create("operators", { name: b.name, username: b.username, role: b.role, skills: b.skills, active: true, password: pass });
    created.push({ username: b.username, password: pass, role: b.role, name: b.name });
  } else if (RESET || !op.passwordHash) {
    const pass = genPass();
    store.update("operators", op.id, { username: b.username, role: b.role, password: pass });
    created.push({ username: b.username, password: pass, role: b.role, name: b.name });
  }
}

// 2) Operadores demo (Ana/Bruno/Carla): username = nombre en minúscula, rol agente.
for (const nm of ["Ana", "Bruno", "Carla"]) {
  const op = byName(nm);
  if (!op) continue;
  const uname = nm.toLowerCase();
  const needPass = RESET || !op.passwordHash;
  const needUser = !op.username;
  if (needPass || needUser) {
    const patch = { username: uname, role: op.role || "agente" };
    let pass = null;
    if (needPass) { pass = genPass(); patch.password = pass; }
    store.update("operators", op.id, patch);
    if (pass) created.push({ username: uname, password: pass, role: op.role || "agente", name: nm });
  }
}

console.log("\n=== EventOS · credenciales de login ===");
if (created.length === 0) {
  console.log("(sin cambios: todos los usuarios ya tenían credencial)");
} else {
  console.log("usuario           contraseña        rol");
  console.log("----------------- ----------------- -----------");
  for (const c of created) {
    console.log(`${c.username.padEnd(17)} ${c.password.padEnd(17)} ${c.role}`);
  }
  console.log("\nGuardá estas claves: NO se vuelven a mostrar (se guardan sólo hasheadas).");
}
console.log("=======================================\n");
