<div align="center">

# ⚡ EventOS · ARC

### Central Receptora de Alarmas (ARC) y Centro de Verificación en Vivo

*Recibí, verificá y despachá eventos de seguridad en tiempo real — cámaras, NVR, analíticas de IA, alarmas y control de accesos — desde una sola consola.*

<!-- 📸 BANNER / HERO — Captura amplia de la consola del operador (mapa + board). Guardar en: docs/img/hero.png -->
![EventOS — Consola de operación](docs/img/hero.png)

<!-- Badges (ajustar cuando el repo sea público) -->
`Node.js` · `Express` · `Socket.io` · `Redis` · `React` · `Vite` · `Leaflet` · `go2rtc` · `Hikvision ISAPI`

</div>

---

## 📑 Tabla de contenidos

- [¿Qué es EventOS?](#-qué-es-eventos)
- [Características](#-características)
- [Capturas](#-capturas)
- [Arquitectura](#-arquitectura)
- [Stack tecnológico](#-stack-tecnológico)
- [Estructura del repositorio](#-estructura-del-repositorio)
- [Puesta en marcha](#-puesta-en-marcha)
- [Configuración](#-configuración-variables-de-entorno)
- [Despliegue](#-despliegue)
- [Seguridad](#-seguridad)
- [Roadmap](#-roadmap)

---

## 🎯 ¿Qué es EventOS?

**EventOS** es una **central receptora de alarmas (ARC)** moderna, inspirada en plataformas tipo HikCentral pero pensada para operación ágil: el foco es que el operario **verifique y accione un evento en segundos**.

Recibe eventos en vivo de **cámaras y NVR Hikvision** (cruce de línea, intrusión de zona, rostro, ANPR, sabotaje…), los **filtra con IA** (persona / vehículo) para recortar falsas alarmas, los reparte entre los operadores según reglas de **despacho**, y le da al operador un **Centro de Verificación** con video en vivo, foto del momento, analíticas dibujadas sobre la imagen, protocolo de actuación y un toque para llamar/abrir puertas.

> **Caso real en producción:** sitio *Cesimco* con 2 NVR Hikvision DS-9632NI-I16 y ~57 cámaras, operadores conectados en vivo.

---

## ✨ Características

### 🖥️ Consola del operador
Pantalla completa con **mapa operativo (GIS)** y **board tipo kanban por criticidad (P1–P5)**. Los eventos entran en vivo por WebSocket, con alerta sonora, SLA con cuenta regresiva y auto-escalado.

<!-- 📸 Captura: board kanban con columnas P1–P5. → docs/img/consola-board.png -->
![Board de eventos](docs/img/consola-board.png)

<!-- 📸 Captura: mapa operativo con marcadores que parpadean por criticidad. → docs/img/mapa.png -->
![Mapa operativo](docs/img/mapa.png)

### 🔎 Centro de Verificación en Vivo (popup)
El corazón de la operación. Al abrir un evento, el operador ve:
- **Video** del evento: foto del momento (evidencia), **vivo** y **grabación**.
- **Galería de fotos del caso** + captura on-demand + descarga.
- **Analíticas dibujadas sobre la imagen** (línea de cruce / zona de intrusión).
- **Panel de respuesta**: protocolo de actuación, lista de llamada priorizada, parlantes SIP y escalación a emergencias.
- **Atajos de teclado** (T=Tomar · A=Acuse · P=En curso · E=Escalar · Esc) y barra de acciones fija para resolver rápido.

<!-- 📸 Captura: popup de verificación con video + panel de respuesta. → docs/img/popup.png -->
![Centro de Verificación](docs/img/popup.png)

### ⚖️ Despacho y balanceo
Reparto de eventos entre operadores: **simultáneo**, **secuencial** (round-robin / menos cargado) o **por reglas**. Tiempos de ack, reasignación, máximo concurrente, enrutado por competencia y grupos de operadores.

<!-- 📸 Captura: página Balanceo. → docs/img/balanceo.png -->
![Balanceo](docs/img/balanceo.png)

### 📷 Dispositivos (cámaras, NVR, alarmas)
Alta *