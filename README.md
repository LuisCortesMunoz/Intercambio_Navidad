# 🎄 Intercambio Navideño

Página para organizar un intercambio de regalos: cada participante registra sus opciones de regalo,
cualquiera puede consultarlas desde su celular o computadora, y el dueño puede corregir errores
desde un panel protegido con contraseña.

- **Servidor:** `server.js` (Node 22.13+ sin dependencias externas), pensado para **Render**.
- **Datos:** base SQLite en un **disco persistente** de Render, compartida por todos.
- **Contraseña del dueño:** variable secreta del servidor; nunca aparece en el código público.

## Publicar en Render (plan Starter)

1. **New → Web Service** y conecta este repositorio.
2. Configuración:

   | Campo | Valor |
   |---|---|
   | Language / Runtime | `Node` |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | `Starter` |

3. **Environment → Environment Variables**:

   | Variable | Valor |
   |---|---|
   | `ADMIN_PASSWORD` | la contraseña del dueño |
   | `DATA_DIR` | `/var/data` |

4. **Disks → Add Disk**: Mount Path `/var/data`, tamaño `1 GB`.
   > Sin disco, los registros se borran en cada despliegue o reinicio.

5. **Deploy**. El link quedará como `https://<nombre-del-servicio>.onrender.com`.

Para cambiar la contraseña del dueño, edita `ADMIN_PASSWORD` en Render (el servicio se reinicia solo).

## Probar en tu computadora

```bash
ADMIN_PASSWORD="tu-contraseña" npm start
```

y abre `http://localhost:3000`. Los datos locales se guardan en `data/` (ignorada por git).

## 🎡 Ruleta del intercambio (sorteo)

**Cómo usarlo (dueño):**

1. **Panel del dueño → 👨‍👩‍👧‍👦 Reglas del intercambio:** crea las familias, asigna a cada persona,
   activa "Evitar regalos entre miembros de la misma familia", agrega restricciones particulares
   y presiona **Comprobar reglas**.
2. **📋 Asignaciones del intercambio → 🎲 Generar sorteo:** se crean *todas* las asignaciones de una vez,
   se validan y se guardan en una sola transacción. Desde ese momento las reglas quedan bloqueadas.
3. **▶️ Activar ruleta** (solo se permite si la validación pasa).
4. Abre **🔑 Códigos de acceso** y envía a cada quien su código con **Copiar mensaje**.
5. Cada participante entra a **🎡 Ruleta del intercambio**, elige su nombre, escribe su código y gira.
   La ruleta solo *anima* el resultado que ya estaba guardado; volver a entrar muestra el mismo resultado.

**Garantías:**

- Algoritmo global (`lib/sorteo.js`): comprueba primero que exista solución (emparejamiento bipartito);
  luego genera una asignación aleatoria (uniforme cuando es posible) y la valida antes de guardarla.
  Si las reglas lo hacen imposible, explica por qué.
- La base de datos impide duplicados (`UNIQUE`), autoasignaciones (`CHECK`) y más de un sorteo a la vez.
- El navegador nunca recibe el destinatario antes de girar ni puede cambiarlo.
- Descargar (.xlsx o .csv) y **Reiniciar intercambio** vuelven a pedir la contraseña del dueño, que se
  verifica en el servidor. El reinicio además pide escribir `REINICIAR` y queda en el **Historial**.
- No se puede eliminar a una persona que participa en el sorteo actual (primero hay que reiniciar).
- Las asignaciones solo viven en la base de datos de Render; nunca en el repositorio.

Variable opcional: `ZONA_HORARIA` (por defecto `America/Mexico_City`) para las fechas del archivo descargado.

## Pruebas

```bash
npm test
```

Prueban miles de sorteos (sin duplicados, nadie se regala a sí mismo, reglas de familia y restricciones),
casos imposibles, y el servidor completo con una base temporal: permisos, idempotencia, giros simultáneos,
descarga y reinicio protegidos por contraseña.

## Notas

- 5 contraseñas incorrectas seguidas bloquean el acceso de dueño desde esa conexión por 15 minutos.
  La sesión del dueño dura 4 horas.
- Los colores son fijos: el modo oscuro/claro del dispositivo no los altera.
