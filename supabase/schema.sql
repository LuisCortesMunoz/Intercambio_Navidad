-- =====================================================================
--  Intercambio Navideño — esquema para Supabase
--  Ejecuta TODO este archivo en Supabase → SQL Editor → New query → Run.
--  Es seguro ejecutarlo varias veces.
--
--  La página pública solo puede llamar a las funciones de este archivo;
--  no tiene acceso directo a las tablas. La contraseña del dueño se guarda
--  cifrada (bcrypt) y se valida aquí, en el servidor.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.people (
  id         bigint generated always as identity primary key,
  name       text not null,
  name_key   text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.gifts (
  id          bigint generated always as identity primary key,
  person_id   bigint not null references public.people(id) on delete cascade,
  name        text not null,
  description text not null,
  created_at  timestamptz not null default now()
);
create index if not exists gifts_person_idx on public.gifts(person_id);

create table if not exists public.admin_config (
  id            int primary key default 1 check (id = 1),
  password_hash text not null
);

create table if not exists public.admin_sessions (
  token_hash text primary key,
  expires_at timestamptz not null
);

create table if not exists public.login_attempts (
  client       text primary key,
  fails        int not null default 0,
  locked_until timestamptz
);

-- Nadie accede a las tablas directamente desde la página: solo vía funciones.
alter table public.people         enable row level security;
alter table public.gifts          enable row level security;
alter table public.admin_config   enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.login_attempts enable row level security;
revoke all on public.people, public.gifts, public.admin_config,
              public.admin_sessions, public.login_attempts from anon, authenticated;

-- ---------------------------------------------------------------------
-- Utilidades internas
-- ---------------------------------------------------------------------
create or replace function public._clean(t text)
returns text language sql immutable as $$
  select btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g'))
$$;

create or replace function public._name_key(t text)
returns text language sql stable
set search_path = public, extensions as $$
  select lower(extensions.unaccent(public._clean(t)))
$$;

create or replace function public._client_id()
returns text language plpgsql stable as $$
declare h json;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  return coalesce(
    nullif(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1), ''),
    h->>'cf-connecting-ip',
    'desconocido');
end $$;

create or replace function public._check_admin(p_token text)
returns boolean language plpgsql
security definer set search_path = public, extensions as $$
begin
  delete from admin_sessions where expires_at < now();
  return exists (
    select 1 from admin_sessions
    where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex'));
end $$;

-- ---------------------------------------------------------------------
-- Funciones públicas
-- ---------------------------------------------------------------------

-- Buscar personas (vacío = todas)
create or replace function public.search_people(p_query text default '')
returns json language plpgsql stable
security definer set search_path = public, extensions as $$
declare
  terms text[] := array_remove(string_to_array(public._name_key(p_query), ' '), '');
begin
  return coalesce((
    select json_agg(json_build_object('id', p.id, 'name', p.name, 'giftCount', p.gift_count)
                    order by lower(p.name))
    from (
      select pe.id, pe.name, pe.name_key,
             (select count(*) from gifts g where g.person_id = pe.id) as gift_count
      from people pe
    ) p
    where coalesce(array_length(terms, 1), 0) = 0
       or (select bool_and(position(t in p.name_key) > 0) from unnest(terms) t)
  ), '[]'::json);
end $$;

-- Una persona con sus opciones
create or replace function public.get_person(p_id bigint)
returns json language plpgsql stable
security definer set search_path = public, extensions as $$
declare r json;
begin
  select json_build_object(
    'id', pe.id, 'name', pe.name,
    'gifts', coalesce((
      select json_agg(json_build_object('id', g.id, 'name', g.name, 'description', g.description,
                                        'createdAt', g.created_at) order by g.id)
      from gifts g where g.person_id = pe.id), '[]'::json))
  into r from people pe where pe.id = p_id;
  if r is null then
    return json_build_object('error', 'Esta persona ya no existe.', 'status', 404);
  end if;
  return json_build_object('person', r);
end $$;

-- Crear perfil (nombre y al menos primer apellido)
create or replace function public.create_person(p_name text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
declare
  v_name text := public._clean(p_name);
  v_key  text;
  w      text;
  words  text[];
  ex     people%rowtype;
  new_id bigint;
begin
  if v_name = '' then
    return json_build_object('error', 'Escribe tu nombre y primer apellido.', 'status', 400);
  end if;
  if char_length(v_name) > 80 then
    return json_build_object('error', 'El nombre es demasiado largo (máx. 80 caracteres).', 'status', 400);
  end if;
  words := string_to_array(v_name, ' ');
  if array_length(words, 1) < 2 then
    return json_build_object('error', 'Debes escribir al menos tu nombre y tu primer apellido.', 'status', 400);
  end if;
  foreach w in array words loop
    if w !~ '^[[:alpha:]][[:alpha:]''’.-]*$' then
      return json_build_object('error', 'El nombre solo puede contener letras, espacios, guiones o apóstrofes.', 'status', 400);
    end if;
    if char_length(regexp_replace(w, '[^[:alpha:]]', '', 'g')) < 2 then
      return json_build_object('error', 'Cada nombre y apellido debe tener al menos 2 letras.', 'status', 400);
    end if;
  end loop;

  v_key := public._name_key(v_name);
  select * into ex from people where name_key = v_key;
  if found then
    return json_build_object(
      'error', format('"%s" ya está registrado. Selecciona ese perfil para agregar opciones.', ex.name),
      'status', 409,
      'person', json_build_object('id', ex.id, 'name', ex.name));
  end if;

  begin
    insert into people (name, name_key) values (v_name, v_key) returning id into new_id;
  exception when unique_violation then
    select * into ex from people where name_key = v_key;
    return json_build_object('error', format('"%s" ya está registrado.', ex.name), 'status', 409,
                             'person', json_build_object('id', ex.id, 'name', ex.name));
  end;
  return json_build_object('person', json_build_object('id', new_id, 'name', v_name, 'giftCount', 0));
end $$;

-- Agregar una opción de regalo
create or replace function public.add_gift(p_person_id bigint, p_name text, p_description text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
declare
  v_name text := public._clean(p_name);
  v_desc text := btrim(regexp_replace(coalesce(p_description, ''), '\r\n?', E'\n', 'g'));
  new_id bigint;
begin
  if not exists (select 1 from people where id = p_person_id) then
    return json_build_object('error', 'Esta persona ya no existe.', 'status', 404);
  end if;
  if v_name = '' and v_desc = '' then
    return json_build_object('error', 'Falta el nombre del regalo y la descripción.', 'status', 400);
  elsif v_name = '' then
    return json_build_object('error', 'Falta el nombre del regalo.', 'status', 400);
  elsif v_desc = '' then
    return json_build_object('error', 'Falta la descripción.', 'status', 400);
  end if;
  if char_length(v_name) > 100 then
    return json_build_object('error', 'El nombre del regalo es muy largo (máx. 100 caracteres).', 'status', 400);
  end if;
  if char_length(v_desc) > 1500 then
    return json_build_object('error', 'La descripción es muy larga (máx. 1500 caracteres).', 'status', 400);
  end if;
  if exists (select 1 from gifts where person_id = p_person_id and lower(name) = lower(v_name)) then
    return json_build_object('error', format('Ya registraste una opción llamada "%s".', v_name), 'status', 409);
  end if;
  insert into gifts (person_id, name, description) values (p_person_id, v_name, v_desc) returning id into new_id;
  return json_build_object('gift', json_build_object('id', new_id, 'name', v_name, 'description', v_desc));
end $$;

-- ---------------------------------------------------------------------
-- Funciones del dueño
-- ---------------------------------------------------------------------

-- Inicio de sesión: 5 intentos fallidos por cliente → bloqueo de 15 minutos.
create or replace function public.admin_login(p_password text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
declare
  v_client text := public._client_id();
  v_att    login_attempts%rowtype;
  v_hash   text;
  v_token  text;
begin
  select * into v_att from login_attempts where client = v_client;
  if found and v_att.locked_until is not null and v_att.locked_until > now() then
    return json_build_object('status', 429, 'error',
      format('Demasiados intentos. Intenta de nuevo en %s min.',
             ceil(extract(epoch from (v_att.locked_until - now())) / 60)::int));
  end if;

  select password_hash into v_hash from admin_config where id = 1;
  if v_hash is null then
    return json_build_object('error', 'La contraseña del dueño aún no se ha configurado.', 'status', 503);
  end if;

  if p_password is null or p_password = '' or char_length(p_password) > 200
     or extensions.crypt(p_password, v_hash) <> v_hash then
    insert into login_attempts as la (client, fails) values (v_client, 1)
      on conflict (client) do update
      set fails = case when la.locked_until is not null and la.locked_until <= now() then 1 else la.fails + 1 end,
          locked_until = case
            when (case when la.locked_until is not null and la.locked_until <= now() then 1 else la.fails + 1 end) >= 5
            then now() + interval '15 minutes' else null end;
    return json_build_object('error', 'Contraseña incorrecta.', 'status', 401);
  end if;

  delete from login_attempts where client = v_client;
  delete from admin_sessions where expires_at < now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into admin_sessions (token_hash, expires_at)
    values (encode(extensions.digest(v_token, 'sha256'), 'hex'), now() + interval '4 hours');
  return json_build_object('token', v_token);
end $$;

create or replace function public.admin_logout(p_token text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  delete from admin_sessions
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_check(p_token text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  return json_build_object('admin', public._check_admin(p_token));
end $$;

create or replace function public.admin_list(p_token text)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  if not public._check_admin(p_token) then
    return json_build_object('error', 'Tu sesión de dueño expiró. Vuelve a ingresar.', 'status', 401);
  end if;
  return json_build_object('people', coalesce((
    select json_agg(json_build_object(
      'id', pe.id, 'name', pe.name,
      'gifts', coalesce((
        select json_agg(json_build_object('id', g.id, 'name', g.name, 'description', g.description,
                                          'createdAt', g.created_at) order by g.id)
        from gifts g where g.person_id = pe.id), '[]'::json))
      order by lower(pe.name))
    from people pe), '[]'::json));
end $$;

create or replace function public.admin_delete_person(p_token text, p_id bigint)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  if not public._check_admin(p_token) then
    return json_build_object('error', 'Tu sesión de dueño expiró. Vuelve a ingresar.', 'status', 401);
  end if;
  delete from people where id = p_id;
  if not found then
    return json_build_object('error', 'La persona ya no existe.', 'status', 404);
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_delete_gift(p_token text, p_id bigint)
returns json language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  if not public._check_admin(p_token) then
    return json_build_object('error', 'Tu sesión de dueño expiró. Vuelve a ingresar.', 'status', 401);
  end if;
  delete from gifts where id = p_id;
  if not found then
    return json_build_object('error', 'La opción ya no existe.', 'status', 404);
  end if;
  return json_build_object('ok', true);
end $$;

-- Establece/cambia la contraseña del dueño. SOLO se puede ejecutar desde el
-- SQL Editor de Supabase (la página pública no tiene permiso).
create or replace function public.set_admin_password(p_password text)
returns text language plpgsql volatile
security definer set search_path = public, extensions as $$
begin
  if p_password is null or char_length(p_password) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;
  insert into admin_config (id, password_hash)
    values (1, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
    on conflict (id) do update set password_hash = excluded.password_hash;
  delete from admin_sessions;
  return 'Contraseña del dueño actualizada.';
end $$;

-- ---------------------------------------------------------------------
-- Permisos: la página (rol anon) solo ejecuta las funciones públicas.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.search_people(text),
  public.get_person(bigint),
  public.create_person(text),
  public.add_gift(bigint, text, text),
  public.admin_login(text),
  public.admin_logout(text),
  public.admin_check(text),
  public.admin_list(text),
  public.admin_delete_person(text, bigint),
  public.admin_delete_gift(text, bigint)
to anon, authenticated;
