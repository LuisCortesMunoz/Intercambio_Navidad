# 🎄 Intercambio Navideño

Página para organizar un intercambio de regalos: cada participante registra sus opciones de regalo,
cualquiera puede consultarlas desde su celular o computadora, y el dueño puede corregir errores
desde un panel protegido con contraseña.

- **Página:** archivos estáticos en `public/`, publicados con **GitHub Pages**.
- **Datos:** base de datos **Supabase** (Postgres), compartida y permanente.
- **Contraseña del dueño:** se guarda cifrada (bcrypt) en Supabase y se valida allí; nunca aparece en el código.

## Puesta en marcha (una sola vez)

### 1. Crear la base de datos en Supabase

1. Entra a [supabase.com](https://supabase.com) (puedes usar tu cuenta de GitHub) y crea un proyecto nuevo (plan gratuito).
2. Abre **SQL Editor → New query**, pega todo el contenido de [`supabase/schema.sql`](supabase/schema.sql) y pulsa **Run**.
3. En otra consulta del SQL Editor ejecuta (con la contraseña que quieras para el dueño):

   ```sql
   select set_admin_password('TU_CONTRASEÑA');
   ```

   > No guardes esta consulta en el repositorio. Para cambiar la contraseña después, vuelve a ejecutarla.

### 2. Conectar la página

En Supabase ve a **Project Settings → API** y copia:

- **Project URL** (ej. `https://abcdefghijkl.supabase.co`)
- **anon public key** (o **publishable key**)

Pégalos en [`public/config.js`](public/config.js). Esta clave es pública por diseño: solo permite usar
las funciones definidas en `schema.sql` (buscar, registrar, y las del dueño, que exigen la contraseña).

### 3. Publicar con GitHub Pages

1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Haz push a `main`. El workflow `.github/workflows/pages.yml` publica la carpeta `public/`.
3. El link quedará en: `https://<tu-usuario>.github.io/Intercambio_Navidad/`

## Probar en tu computadora

```bash
npx serve public
```

y abre la dirección que indique (ej. `http://localhost:3000`).

## Notas

- En el plan gratuito, Supabase **pausa** el proyecto tras 7 días sin visitas. Los datos no se pierden:
  basta con entrar a Supabase y pulsar **Restore project**.
- Bloqueo de seguridad: 5 contraseñas incorrectas seguidas bloquean el acceso de dueño desde ese
  dispositivo por 15 minutos. La sesión del dueño dura 4 horas.
- Los colores son fijos: el modo oscuro/claro del dispositivo no los altera.
