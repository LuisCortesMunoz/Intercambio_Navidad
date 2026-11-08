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

## Notas

- 5 contraseñas incorrectas seguidas bloquean el acceso de dueño desde esa conexión por 15 minutos.
  La sesión del dueño dura 4 horas.
- Los colores son fijos: el modo oscuro/claro del dispositivo no los altera.
