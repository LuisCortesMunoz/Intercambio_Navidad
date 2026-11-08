'use strict';

(() => {
  /* ==========================================================
     Utilidades
     ========================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function svg(markup, cls) {
    const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wrap.setAttribute('viewBox', '0 0 24 24');
    wrap.setAttribute('aria-hidden', 'true');
    if (cls) wrap.setAttribute('class', cls);
    wrap.innerHTML = markup; // solo se usa con marcado fijo, nunca con datos del usuario
    return wrap;
  }
  const ICON_TRASH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>';
  const ICON_CHEV = '<path d="M9 6l6 6-6 6"/>';

  function giftIcon(i) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 64 64');
    s.setAttribute('class', 'gift-icon');
    s.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', ['#gift-red', '#gift-green', '#gift-gold'][i % 3]);
    s.append(use);
    return s;
  }

  const normalize = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  function initials(name) {
    const w = name.split(' ');
    return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase();
  }
  function avatar(name, big) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return el('div', { class: `avatar c${h % 4}${big ? ' big' : ''}`, text: initials(name), 'aria-hidden': 'true' });
  }
  function setAvatar(node, name) {
    const a = avatar(name);
    node.className = a.className;
    node.textContent = a.textContent;
  }

  /** Nombre con las palabras que coinciden resaltadas. */
  function highlightName(name, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    const frag = document.createDocumentFragment();
    name.split(' ').forEach((word, i) => {
      if (i) frag.append(' ');
      const nw = normalize(word);
      const t = terms.find((t) => nw.startsWith(t));
      if (t) {
        frag.append(el('mark', { text: word.slice(0, t.length) }), word.slice(t.length));
      } else frag.append(word);
    });
    return frag;
  }

  /** Texto con enlaces http(s) clicables, sin usar innerHTML. */
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /\bhttps?:\/\/[^\s<>"']+/gi;
    let last = 0, m;
    while ((m = re.exec(text))) {
      let url = m[0].replace(/[).,;:!?]+$/, '');
      frag.append(text.slice(last, m.index));
      frag.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', text: url }));
      last = m.index + url.length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ==========================================================
     API (Supabase: funciones definidas en supabase/schema.sql)
     ========================================================== */
  const CONFIG = window.INTERCAMBIO_CONFIG || {};
  const SUPABASE_URL = String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_KEY = String(CONFIG.SUPABASE_KEY || '');
  const CONFIGURED = /^https:\/\//.test(SUPABASE_URL) && SUPABASE_KEY.length > 20;

  async function rpc(fn, args = {}, { signal } = {}) {
    if (!CONFIGURED) {
      throw Object.assign(new Error('La página aún no está conectada a la base de datos (falta configurar public/config.js).'), { status: 0 });
    }
    const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
    // Las claves "anon" antiguas son JWT y también van en Authorization.
    if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(args), signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw Object.assign(new Error('No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      console.error('Supabase', fn, res.status, data);
      throw Object.assign(new Error('Ocurrió un error en el servidor. Intenta de nuevo en un momento.'), { status: res.status });
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      throw Object.assign(new Error(data.error), { status: data.status || 400, data });
    }
    return data;
  }

  // Sesión del dueño: el token solo vive en esta pestaña.
  const adminToken = {
    get() { try { return sessionStorage.getItem('intercambio_admin') || this._mem || ''; } catch { return this._mem || ''; } },
    set(t) { this._mem = t; try { t ? sessionStorage.setItem('intercambio_admin', t) : sessionStorage.removeItem('intercambio_admin'); } catch { /* sin almacenamiento */ } },
  };

  /** "josé  luis PÉREZ" -> "José Luis Pérez" (respeta "McDonald", "O'Connor"). */
  function tidyName(str) {
    const fix = (p) => {
      const lower = p.toLocaleLowerCase('es');
      const mixed = p !== lower && p !== p.toLocaleUpperCase('es');
      return mixed ? p.charAt(0).toLocaleUpperCase('es') + p.slice(1)
        : lower.charAt(0).toLocaleUpperCase('es') + lower.slice(1);
    };
    return String(str).replace(/\s+/g, ' ').trim().split(' ').map((w) => w.split('-').map(fix).join('-')).join(' ');
  }

  const api = {
    searchPeople: (q, signal) => rpc('search_people', { p_query: q }, { signal }),
    getPerson: (id) => rpc('get_person', { p_id: id }),
    createPerson: (name) => rpc('create_person', { p_name: tidyName(name) }),
    addGift: (personId, name, description) => rpc('add_gift', { p_person_id: personId, p_name: name, p_description: description }),
    async login(password) { const { token } = await rpc('admin_login', { p_password: password }); adminToken.set(token); },
    async logout() { const t = adminToken.get(); adminToken.set(''); if (t) await rpc('admin_logout', { p_token: t }); },
    async isAdmin() { const t = adminToken.get(); if (!t) return false; const { admin } = await rpc('admin_check', { p_token: t }); if (!admin) adminToken.set(''); return admin; },
    adminList: () => rpc('admin_list', { p_token: adminToken.get() }),
    deletePerson: (id) => rpc('admin_delete_person', { p_token: adminToken.get(), p_id: id }),
    deleteGift: (id) => rpc('admin_delete_gift', { p_token: adminToken.get(), p_id: id }),
  };

  /* ==========================================================
     Mensajes (toasts) y confirmación
     ========================================================== */
  function toast(message, type = 'ok') {
    const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
      el('span', { class: 'toast-ico', text: type === 'error' ? '⚠️' : type === 'info' ? '🔔' : '🎁' }),
      el('span', { text: message }));
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 4500 : 3200);
  }

  function confirmDialog(title, text, okLabel = 'Eliminar') {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    const prevFocus = document.activeElement;
    modal.hidden = false;
    $('[data-close].btn', modal).focus();
    return new Promise((resolve) => {
      const close = (val) => {
        modal.hidden = true;
        modal.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        prevFocus?.focus?.();
        resolve(val);
      };
      const onClick = (e) => {
        if (e.target.closest('#confirm-ok')) close(true);
        else if (e.target.closest('[data-close]')) close(false);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      modal.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
    });
  }

  function markInvalid(input) {
    input.classList.remove('invalid');
    void input.offsetWidth; // reinicia la animación
    input.classList.add('invalid');
    input.focus();
    input.addEventListener('input', () => input.classList.remove('invalid'), { once: true });
  }

  async function withBusy(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    try { return await fn(); } finally { button.disabled = false; }
  }

  /* ==========================================================
     Búsqueda de personas (compartida por "Agregar" y "Ver")
     ========================================================== */
  function setupPersonSearch({ input, list, onSelect, showAllWhenEmpty, emptyText, onResults }) {
    let controller;
    let activeId = null;

    async function run() {
      const query = input.value.trim();
      controller?.abort();
      if (!query && !showAllWhenEmpty) { list.replaceChildren(); onResults?.(query, []); return; }
      controller = new AbortController();
      try {
        const people = (await api.searchPeople(query, controller.signal)) || [];
        render(people, query);
        onResults?.(query, people);
      } catch (e) {
        if (e.name !== 'AbortError') list.replaceChildren(el('li', { class: 'empty-msg', text: e.message }));
      }
    }

    function render(people, query) {
      if (!people.length) {
        list.replaceChildren(el('li', { class: 'empty-msg', text: query ? emptyText(query) : 'Aún no hay participantes registrados.' }));
        return;
      }
      list.replaceChildren(...people.map((p) => el('li', {},
        el('button', {
          type: 'button', class: `result${p.id === activeId ? ' active' : ''}`, role: 'option',
          'aria-selected': String(p.id === activeId),
          onclick: () => { activeId = p.id; onSelect(p); render(people, query); },
        },
        avatar(p.name),
        el('span', { class: 'result-name' }, highlightName(p.name, query)),
        el('span', { class: 'result-meta', text: plural(p.giftCount, 'opción', 'opciones') })),
      )));
    }

    const debounced = debounce(run, 150);
    input.addEventListener('input', debounced);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('.result', list)?.click(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); $('.result', list)?.focus(); }
    });
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('.result')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i === 0 ? input : items[i - 1]).focus(); }
    });

    return {
      refresh: run,
      reset() { input.value = ''; activeId = null; list.replaceChildren(); },
      setActive(id) { activeId = id; },
    };
  }

  function renderGiftItem(g, i) {
    return el('li', { class: 'gift-item' },
      giftIcon(i),
      el('div', { class: 'gift-body' },
        el('h4', { text: g.name }),
        el('p', {}, linkify(g.description)),
        g.createdAt ? el('span', { class: 'gift-date', text: `Agregado el ${formatDate(g.createdAt)}` }) : null));
  }

  /* ==========================================================
     Vista: Agregar opciones
     ========================================================== */
  const add = (() => {
    const stepFind = $('#add-step-find');
    const stepGifts = $('#add-step-gifts');
    const searchInput = $('#add-search');
    const createName = $('#create-name');
    const giftName = $('#gift-name');
    const giftDesc = $('#gift-desc');
    let person = null;

    const search = setupPersonSearch({
      input: searchInput,
      list: $('#add-results'),
      showAllWhenEmpty: false,
      emptyText: (q) => `No encontramos a "${q}". Crea tu perfil abajo.`,
      onSelect: (p) => selectPerson(p),
      onResults: (query, people) => {
        // Sugiere el texto buscado como nombre para el nuevo perfil
        if (query && !people.length && !createName.dataset.touched) createName.value = query;
      },
    });

    createName.addEventListener('input', () => { createName.dataset.touched = '1'; });

    $('#create-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = e.submitter || $('#create-form button');
      const name = createName.value.replace(/\s+/g, ' ').trim();
      if (!name) { markInvalid(createName); toast('Escribe tu nombre y primer apellido.', 'error'); return; }
      if (name.split(' ').length < 2) { markInvalid(createName); toast('Debes escribir al menos tu nombre y tu primer apellido.', 'error'); return; }
      withBusy(btn, async () => {
        try {
          const { person: p } = await api.createPerson(name);
          toast(`¡Perfil creado! Bienvenido(a), ${p.name}.`);
          selectPerson(p);
        } catch (err) {
          if (err.status === 409 && err.data?.person) {
            toast(`${err.data.person.name} ya estaba registrado. Te llevamos a su perfil.`, 'info');
            selectPerson(err.data.person);
          } else { markInvalid(createName); toast(err.message, 'error'); }
        }
      });
    });

    async function selectPerson(p) {
      person = p;
      $('#add-person-name').textContent = p.name;
      setAvatar($('#add-avatar'), p.name);
      stepFind.hidden = true;
      stepGifts.hidden = false;
      giftName.value = ''; giftDesc.value = ''; updateCounter();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => giftName.focus({ preventScroll: true }), 250);
      await loadGifts();
    }

    async function loadGifts() {
      const list = $('#my-gifts');
      list.replaceChildren(el('li', { class: 'loading', text: 'Cargando…' }));
      try {
        const { person: p } = await api.getPerson(person.id);
        $('#my-gift-count').textContent = p.gifts.length;
        list.replaceChildren(...(p.gifts.length
          ? p.gifts.slice().reverse().map(renderGiftItem)
          : [el('li', { class: 'empty-msg', text: 'Todavía no tienes opciones. ¡Agrega la primera arriba! 🎄' })]));
      } catch (err) {
        if (err.status === 404) { toast(err.message, 'error'); reset(); return; }
        list.replaceChildren(el('li', { class: 'empty-msg', text: err.message }));
      }
    }

    function updateCounter() { $('#gift-desc-count').textContent = `${giftDesc.value.length} / 1500`; }
    giftDesc.addEventListener('input', updateCounter);

    $('#gift-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = e.submitter || $('#gift-form button');
      const name = giftName.value.trim();
      const description = giftDesc.value.trim();
      if (!name || !description) {
        markInvalid(!name ? giftName : giftDesc);
        toast(!name && !description ? 'Falta el nombre del regalo y la descripción.'
          : !name ? 'Falta el nombre del regalo.' : 'Falta la descripción del regalo.', 'error');
        return;
      }
      withBusy(btn, async () => {
        try {
          await api.addGift(person.id, name, description);
          toast(`¡"${name}" se guardó correctamente!`);
          giftName.value = ''; giftDesc.value = ''; updateCounter();
          giftName.focus();
          await loadGifts();
        } catch (err) {
          if (err.status === 404) { toast(err.message, 'error'); reset(); return; }
          toast(err.message, 'error');
        }
      });
    });

    $('#change-person').addEventListener('click', reset);

    function reset() {
      person = null;
      stepGifts.hidden = true;
      stepFind.hidden = false;
      search.reset();
      createName.value = ''; delete createName.dataset.touched;
    }

    return {
      enter() { if (!person) { reset(); setTimeout(() => searchInput.focus(), 50); } else loadGifts(); },
    };
  })();

  /* ==========================================================
     Vista: Ver opciones
     ========================================================== */
  const view = (() => {
    const detail = $('#view-detail');
    let current = null;

    const search = setupPersonSearch({
      input: $('#view-search'),
      list: $('#view-results'),
      showAllWhenEmpty: true,
      emptyText: (q) => `No hay nadie registrado que coincida con "${q}".`,
      onSelect: (p) => show(p),
    });

    async function show(p) {
      current = p;
      detail.hidden = false;
      $('#view-person-name').textContent = p.name;
      setAvatar($('#view-avatar'), p.name);
      $('#view-gift-count').textContent = '…';
      const list = $('#view-gifts');
      list.replaceChildren(el('li', { class: 'empty-msg loading', text: 'Cargando opciones…' }));
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        const { person } = await api.getPerson(p.id);
        if (current !== p) return;
        $('#view-gift-count').textContent = plural(person.gifts.length, 'opción', 'opciones');
        list.replaceChildren(...(person.gifts.length
          ? person.gifts.map(renderGiftItem)
          : [el('li', { class: 'empty-msg', text: `${person.name} aún no ha registrado opciones de regalo.` })]));
      } catch (err) {
        list.replaceChildren(el('li', { class: 'empty-msg', text: err.message }));
        if (err.status === 404) search.refresh();
      }
    }

    return {
      enter() {
        current = null; detail.hidden = true; search.reset(); search.refresh();
        setTimeout(() => $('#view-search').focus(), 50);
      },
    };
  })();

  /* ==========================================================
     Vista: Dueño
     ========================================================== */
  const admin = (() => {
    const loginCard = $('#admin-login');
    const panel = $('#admin-panel');
    const listEl = $('#admin-list');
    const filter = $('#admin-filter');
    let people = [];
    const openIds = new Set();

    function showLogin() {
      panel.hidden = true; loginCard.hidden = false;
      $('#admin-password').value = '';
      setTimeout(() => $('#admin-password').focus(), 50);
    }

    async function showPanel() {
      loginCard.hidden = true; panel.hidden = false;
      await load();
    }

    async function load() {
      if (!people.length) listEl.replaceChildren(el('div', { class: 'empty-msg loading', text: 'Cargando…' }));
      try {
        ({ people } = await api.adminList());
        render();
      } catch (err) { handleError(err); }
    }

    function handleError(err) {
      toast(err.message, 'error');
      if (err.status === 401) { people = []; showLogin(); }
    }

    function render() {
      $('#stat-people').textContent = people.length;
      $('#stat-gifts').textContent = people.reduce((n, p) => n + p.gifts.length, 0);
      const terms = normalize(filter.value).split(' ').filter(Boolean);
      const shown = people.filter((p) => terms.every((t) => normalize(p.name).includes(t)));
      if (!shown.length) {
        listEl.replaceChildren(el('div', { class: 'empty-msg', text: people.length ? 'Nadie coincide con el filtro.' : 'Aún no hay personas registradas.' }));
        return;
      }
      listEl.replaceChildren(...shown.map((p) => {
        const details = el('details', { class: 'admin-person', open: openIds.has(p.id) },
          el('summary', {},
            svg(ICON_CHEV, 'chev'),
            avatar(p.name),
            el('span', { class: 'admin-person-name', text: p.name }),
            el('span', { class: 'badge', text: p.gifts.length, title: plural(p.gifts.length, 'opción', 'opciones') }),
            el('button', {
              type: 'button', class: 'icon-btn', title: `Eliminar a ${p.name}`, 'aria-label': `Eliminar a ${p.name} y todas sus opciones`,
              onclick: (e) => { e.preventDefault(); e.stopPropagation(); deletePerson(p); },
            }, svg(ICON_TRASH))),
          el('ul', { class: 'admin-gifts' },
            p.gifts.length ? p.gifts.map((g) => el('li', { class: 'admin-gift' },
              el('div', { class: 'gift-body' },
                el('h4', { text: g.name }),
                el('p', {}, linkify(g.description)),
                el('span', { class: 'gift-date', text: formatDate(g.createdAt) })),
              el('button', {
                type: 'button', class: 'icon-btn', title: 'Eliminar opción', 'aria-label': `Eliminar la opción ${g.name}`,
                onclick: () => deleteGift(p, g),
              }, svg(ICON_TRASH))))
              : el('li', { class: 'empty-msg', text: 'Sin opciones registradas.' })));
        details.addEventListener('toggle', () => { details.open ? openIds.add(p.id) : openIds.delete(p.id); });
        return details;
      }));
    }

    async function deletePerson(p) {
      const ok = await confirmDialog('¿Eliminar persona?',
        `Se eliminará a "${p.name}" junto con ${plural(p.gifts.length, 'opción', 'opciones')} de regalo. Esta acción no se puede deshacer.`,
        'Sí, eliminar');
      if (!ok) return;
      try {
        await api.deletePerson(p.id);
        toast(`Se eliminó a ${p.name}.`);
      } catch (err) { handleError(err); }
      await load();
    }

    async function deleteGift(p, g) {
      const ok = await confirmDialog('¿Eliminar opción?',
        `Se eliminará "${g.name}" de la lista de ${p.name}. Esta acción no se puede deshacer.`, 'Sí, eliminar');
      if (!ok) return;
      try {
        await api.deleteGift(g.id);
        toast(`Se eliminó la opción "${g.name}".`);
      } catch (err) { handleError(err); }
      await load();
    }

    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#admin-password');
      const btn = e.submitter || $('#login-form button');
      if (!input.value) { markInvalid(input); toast('Escribe la contraseña.', 'error'); return; }
      withBusy(btn, async () => {
        try {
          await api.login(input.value);
          input.value = '';
          toast('Bienvenido, dueño. 🎅');
          await showPanel();
        } catch (err) { input.value = ''; markInvalid(input); toast(err.message, 'error'); }
      });
    });

    filter.addEventListener('input', render);
    $('#admin-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, load));
    $('#admin-logout').addEventListener('click', async () => {
      try { await api.logout(); } catch { /* ignorar */ }
      people = []; openIds.clear(); filter.value = '';
      toast('Sesión cerrada.', 'info');
      location.hash = '#/';
    });

    return {
      async enter() {
        loginCard.hidden = true; panel.hidden = true;
        try {
          (await api.isAdmin()) ? showPanel() : showLogin();
        } catch { showLogin(); }
      },
    };
  })();

  /* ==========================================================
     Navegación (hash)
     ========================================================== */
  const ROUTES = { '': 'home', agregar: 'agregar', ver: 'ver', dueno: 'dueno' };
  const ENTER = { agregar: add.enter, ver: view.enter, dueno: admin.enter };

  function route() {
    const key = location.hash.replace(/^#\/?/, '').split('/')[0];
    const name = ROUTES[key] || 'home';
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    window.scrollTo(0, 0);
    ENTER[name]?.();
  }
  window.addEventListener('hashchange', route);
  route();
  if (!CONFIGURED) toast('Falta conectar la base de datos: configura public/config.js.', 'error');

  /* ==========================================================
     Decoración: luces y nieve
     ========================================================== */
  (function lights() {
    const ul = $('#lights');
    const count = Math.ceil(window.innerWidth / 46) + 2;
    for (let i = 0; i < count; i++) ul.append(el('li'));
  })();

  (function snow() {
    const canvas = $('#snow');
    const ctx = canvas.getContext('2d');
    if (!ctx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let w, h, flakes = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round(Math.min(110, (w * h) / 14000));
      while (flakes.length < target) flakes.push(make(true));
      flakes.length = target;
    }
    function make(anywhere) {
      return {
        x: Math.random() * w, y: anywhere ? Math.random() * h : -10,
        r: Math.random() * 2.4 + .8, s: Math.random() * .6 + .3,
        drift: Math.random() * .6 - .3, phase: Math.random() * Math.PI * 2,
        o: Math.random() * .5 + .35,
      };
    }
    let last = performance.now();
    function frame(now) {
      const dt = Math.min((now - last) / 16.67, 3); last = now;
      ctx.clearRect(0, 0, w, h);
      for (const f of flakes) {
        f.phase += .01 * dt;
        f.y += f.s * dt * (f.r / 1.6);
        f.x += (f.drift + Math.sin(f.phase) * .35) * dt;
        if (f.y > h + 5) Object.assign(f, make(false));
        if (f.x > w + 5) f.x = -5; else if (f.x < -5) f.x = w + 5;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${f.o})`;
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    window.addEventListener('resize', debounce(resize, 150));
    resize();
    requestAnimationFrame(frame);
  })();
})();
