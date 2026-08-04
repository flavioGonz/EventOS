#!/bin/bash
# Verifica el modulo de zonas YA DESPLEGADO, sin esperar un evento real.
set -uo pipefail
cd /opt/eventos
echo "== 1. el modulo desplegado resuelve casos reales"
node --input-type=module -e '
const { resolveZone, zonesOfChannel, zonesInfo } = await import("/opt/eventos/server/src/events/zones.js");
console.log("   mapa:", JSON.stringify(zonesInfo()));
const casos = [
  ["srv1","6","fielddetection","1","intrusion en Carga"],
  ["srv1","2","linedetection","3","canal con 4 lineas -> elige la 3"],
  ["srv1","6","linedetection",null,"sin regionID, una sola regla -> resuelve"],
  ["srv1","2","linedetection",null,"sin regionID, 4 reglas -> no adivina"],
  ["srv2","29","linedetection","2","Carga Camiones HD"],
  ["srv2","1","linedetection","1","canal sin reglas -> null"],
];
for (const [s,c,t,r,d] of casos) {
  const z = resolveZone(s,c,t,r);
  console.log("   " + String(z ? z.name : "null").padEnd(28) + "  <- " + s + " ch" + c + " " + t + " region=" + r + "   (" + d + ")");
}
'
echo
echo "== 2. canales con reglas (ahi es donde se va a ver el cambio)"
node --input-type=module -e '
const { zonesOfChannel } = await import("/opt/eventos/server/src/events/zones.js");
for (const s of ["srv1","srv2"]) for (let c=1;c<=29;c++) {
  const z = zonesOfChannel(s,String(c));
  if (z.length) console.log("   " + s + " ch" + String(c).padStart(2) + "  " + z.map(x=>x.name).join(" | "));
}
'
echo
echo "== 3. eventos de alertStream en la ultima hora, en canales CON reglas"
journalctl -u eventos-api --since "1 hour ago" --no-pager \
  | grep -E "alertStream\[" | grep -vE "conectado|reconect|termin" | tail -25 || echo "   (sin eventos todavia)"
echo
echo "== 4. estado del servicio"
systemctl is-active eventos-api
