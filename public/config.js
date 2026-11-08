/*
 * Configuración de Supabase.
 * Copia estos dos valores desde Supabase → Project Settings → API (o "Data API" / "API Keys"):
 *   - Project URL
 *   - anon public key  (o la "publishable key", que empieza con sb_publishable_)
 *
 * Esta clave es PÚBLICA por diseño: solo permite llamar a las funciones de
 * supabase/schema.sql. La contraseña del dueño NO va aquí; se configura en Supabase.
 */
window.INTERCAMBIO_CONFIG = {
  SUPABASE_URL: 'PEGA_AQUI_TU_PROJECT_URL',      // ej. https://abcdefghijkl.supabase.co
  SUPABASE_KEY: 'PEGA_AQUI_TU_ANON_KEY',
};
