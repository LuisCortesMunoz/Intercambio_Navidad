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
  const ICON_EDIT = '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>';
  const ICON_LINK = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';

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
     API (servidor: server.js → POST /api/rpc/<función>)
     ========================================================== */
  async function rpc(fn, args = {}, { signal } = {}) {
    let res;
    try {
      res = await fetch(`api/rpc/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal, credentials: 'same-origin',
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw Object.assign(new Error('No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      throw Object.assign(new Error(data?.error || 'Ocurrió un error en el servidor. Intenta de nuevo en un momento.'), { status: res.status });
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

  // Sesión del participante en la ruleta: también solo vive en esta pestaña.
  const playerToken = {
    get() { try { return sessionStorage.getItem('intercambio_ruleta') || this._mem || ''; } catch { return this._mem || ''; } },
    set(t) { this._mem = t; try { t ? sessionStorage.setItem('intercambio_ruleta', t) : sessionStorage.removeItem('intercambio_ruleta'); } catch { /* sin almacenamiento */ } },
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
    addGift: (personId, g) => rpc('add_gift', { p_person_id: personId, p_name: g.name, p_description: g.description, p_link: g.link }),
    updateGift: (personId, giftId, g) => rpc('update_gift', { p_person_id: personId, p_gift_id: giftId, p_name: g.name, p_description: g.description, p_link: g.link }),
    async login(password) { const { token } = await rpc('admin_login', { p_password: password }); adminToken.set(token); },
    async logout() { const t = adminToken.get(); adminToken.set(''); if (t) await rpc('admin_logout', { p_token: t }); },
    async isAdmin() { const t = adminToken.get(); if (!t) return false; const { admin } = await rpc('admin_check', { p_token: t }); if (!admin) adminToken.set(''); return admin; },
    adminList: () => rpc('admin_list', { p_token: adminToken.get() }),
    deletePerson: (id) => rpc('admin_delete_person', { p_token: adminToken.get(), p_id: id }),
    deleteGift: (id) => rpc('admin_delete_gift', { p_token: adminToken.get(), p_id: id }),

    // Reglas y sorteo (dueño)
    rules: () => rpc('admin_rules', { p_token: adminToken.get() }),
    saveFamily: (id, name) => rpc('admin_family_save', { p_token: adminToken.get(), p_id: id, p_name: name }),
    deleteFamily: (id) => rpc('admin_family_delete', { p_token: adminToken.get(), p_id: id }),
    setFamily: (personId, familyId) => rpc('admin_set_family', { p_token: adminToken.get(), p_person_id: personId, p_family_id: familyId }),
    setRule: (avoid) => rpc('admin_set_rule', { p_token: adminToken.get(), p_avoid_same_family: avoid }),
    addRestriction: (g, r, mutual) => rpc('admin_restriction_add', { p_token: adminToken.get(), p_giver_id: g, p_receiver_id: r, p_mutual: mutual }),
    deleteRestriction: (id) => rpc('admin_restriction_delete', { p_token: adminToken.get(), p_id: id }),
    feasibility: () => rpc('admin_check_feasibility', { p_token: adminToken.get() }),
    generateDraw: (requestId) => rpc('admin_draw_generate', { p_token: adminToken.get(), p_request_id: requestId }),
    validateDraw: () => rpc('admin_draw_validate', { p_token: adminToken.get() }),
    setDrawActive: (active) => rpc('admin_draw_set_active', { p_token: adminToken.get(), p_active: active }),
    resetDraw: (password, drawId, confirm) => rpc('admin_draw_reset', { p_token: adminToken.get(), p_password: password, p_draw_id: drawId, p_confirm: confirm }),
    assignments: () => rpc('admin_assignments', { p_token: adminToken.get() }),
    codes: () => rpc('admin_codes', { p_token: adminToken.get() }),
    regenerateCode: (personId) => rpc('admin_code_regenerate', { p_token: adminToken.get(), p_person_id: personId }),
    exportDraw: (password, format) => rpc('admin_export', { p_token: adminToken.get(), p_password: password, p_format: format }),

    // Ruleta (participantes)
    ruletaStatus: () => rpc('ruleta_status'),
    async ruletaLogin(personId, code) { const r = await rpc('ruleta_login', { p_person_id: personId, p_code: code }); playerToken.set(r.token); return r; },
    async ruletaLogout() { const t = playerToken.get(); playerToken.set(''); if (t) await rpc('ruleta_logout', { p_token: t }); },
    ruletaMe: () => rpc('ruleta_me', { p_token: playerToken.get() }),
    ruletaSpin: () => rpc('ruleta_spin', { p_token: playerToken.get() }),
    ruletaGifts: () => rpc('ruleta_recipient_gifts', { p_token: playerToken.get() }),
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

  /**
   * Pide de nuevo la contraseña del dueño (y opcionalmente formato o palabra de confirmación).
   * onSubmit({ password, format, confirm }) se ejecuta con la ventana abierta; si lanza un error
   * de contraseña, la ventana sigue abierta para reintentar. Resuelve true si terminó bien.
   */
  function authDialog({ title, text, okLabel = 'Continuar', withFormat = false, confirmWord = '', onSubmit }) {
    const modal = $('#auth-modal');
    const form = $('#auth-form');
    const pass = $('#auth-password');
    const confirmInput = $('#auth-confirm');
    $('#auth-title').textContent = title;
    $('#auth-text').textContent = text;
    $('#auth-ok').textContent = okLabel;
    $('#auth-format').hidden = !withFormat;
    $('#auth-confirm-field').hidden = !confirmWord;
    pass.value = ''; confirmInput.value = '';
    const prevFocus = document.activeElement;
    modal.hidden = false;
    setTimeout(() => (confirmWord ? confirmInput : pass).focus(), 50);
    return new Promise((resolve) => {
      const close = (val) => {
        modal.hidden = true; pass.value = '';
        modal.removeEventListener('click', onClick);
        form.removeEventListener('submit', onSubmitForm);
        document.removeEventListener('keydown', onKey);
        prevFocus?.focus?.();
        resolve(val);
      };
      const onClick = (e) => { if (e.target.closest('[data-close]')) close(false); };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const onSubmitForm = (e) => {
        e.preventDefault();
        if (confirmWord && confirmInput.value.trim().toUpperCase() !== confirmWord) {
          markInvalid(confirmInput); toast(`Escribe ${confirmWord} para confirmar.`, 'error'); return;
        }
        if (!pass.value) { markInvalid(pass); toast('Escribe la contraseña.', 'error'); return; }
        const format = form.querySelector('input[name="auth-format"]:checked')?.value || 'xlsx';
        withBusy($('#auth-ok'), async () => {
          try {
            await onSubmit({ password: pass.value, format, confirm: confirmInput.value.trim() });
            close(true);
          } catch (err) {
            toast(err.message, 'error');
            if (err.status === 401 && err.data?.badPassword) { pass.value = ''; markInvalid(pass); return; }
            close(false);
            if (err.status === 401) admin.handleError(err);
          }
        });
      };
      modal.addEventListener('click', onClick);
      form.addEventListener('submit', onSubmitForm);
      document.addEventListener('keydown', onKey);
    });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /** Identificador aleatorio para que un reintento no genere un segundo resultado. */
  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* sin permiso */ }
    const ta = el('textarea', { class: 'sr-only', readonly: true });
    ta.value = text;
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* no soportado */ }
    ta.remove();
    return ok;
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
  function setupPersonSearch({ input, list, onSelect, showAllWhenEmpty, emptyText, onResults, source = null, meta = null }) {
    let controller;
    let activeId = null;

    async function run() {
      const query = input.value.trim();
      controller?.abort();
      if (!query && !showAllWhenEmpty) { list.replaceChildren(); onResults?.(query, []); return; }
      controller = new AbortController();
      try {
        const people = (await (source || api.searchPeople)(query, controller.signal)) || [];
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
      list.replaceChildren(...people.map((p) => {
        const metaText = meta ? meta(p) : plural(p.giftCount, 'opción', 'opciones');
        return el('li', {},
          el('button', {
            type: 'button', class: `result${p.id === activeId ? ' active' : ''}`, role: 'option',
            'aria-selected': String(p.id === activeId),
            onclick: () => { activeId = p.id; onSelect(p); render(people, query); },
          },
          avatar(p.name),
          el('span', { class: 'result-name' }, highlightName(p.name, query)),
          metaText ? el('span', { class: 'result-meta', text: metaText }) : null));
      }));
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

  /** Botón que abre el enlace de una opción en otra pestaña. */
  function giftLinkButton(link) {
    if (!/^https?:\/\//i.test(link || '')) return null;
    let host = '';
    try { host = new URL(link).hostname.replace(/^www\./, ''); } catch { return null; }
    return el('a', { class: 'gift-link', href: link, target: '_blank', rel: 'noopener noreferrer nofollow', title: link },
      svg(ICON_LINK), el('span', { text: 'Ver enlace' }), el('small', { text: host }));
  }

  function renderGiftItem(g, i, { onEdit } = {}) {
    return el('li', { class: 'gift-item' },
      giftIcon(i),
      el('div', { class: 'gift-body' },
        el('h4', { text: g.name }),
        el('p', {}, linkify(g.description)),
        giftLinkButton(g.link),
        g.createdAt ? el('span', { class: 'gift-date', text: `Agregado el ${formatDate(g.createdAt)}` }) : null),
      onEdit ? el('button', {
        type: 'button', class: 'icon-btn icon-btn-edit', title: 'Modificar opción', 'aria-label': `Modificar la opción ${g.name}`,
        onclick: () => onEdit(g),
      }, svg(ICON_EDIT)) : null);
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
    const giftLink = $('#gift-link');
    let person = null;
    let editing = null; // opción que se está modificando

    function clearGiftForm() {
      giftName.value = ''; giftDesc.value = ''; giftLink.value = ''; updateCounter();
    }

    function startEdit(g) {
      editing = g;
      giftName.value = g.name;
      giftDesc.value = g.description;
      giftLink.value = g.link || '';
      updateCounter();
      $('#gift-form-title').textContent = 'Modificar opción';
      $('#gift-submit-label').textContent = 'Guardar cambios';
      $('#gift-cancel').hidden = false;
      $('#gift-form').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => giftName.focus({ preventScroll: true }), 300);
    }

    function stopEdit() {
      editing = null;
      clearGiftForm();
      $('#gift-form-title').textContent = 'Nueva opción de regalo';
      $('#gift-submit-label').textContent = 'Guardar opción';
      $('#gift-cancel').hidden = true;
    }

    $('#gift-cancel').addEventListener('click', () => { stopEdit(); giftName.focus(); });

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
      stopEdit();
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
          ? p.gifts.slice().reverse().map((g, i) => renderGiftItem(g, i, { onEdit: startEdit }))
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
      const link = giftLink.value.trim();
      if (!name || !description) {
        markInvalid(!name ? giftName : giftDesc);
        toast(!name && !description ? 'Falta el nombre del regalo y la descripción.'
          : !name ? 'Falta el nombre del regalo.' : 'Falta la descripción del regalo.', 'error');
        return;
      }
      withBusy(btn, async () => {
        try {
          if (editing) {
            await api.updateGift(person.id, editing.id, { name, description, link });
            toast(`¡"${name}" se actualizó correctamente!`);
          } else {
            await api.addGift(person.id, { name, description, link });
            toast(`¡"${name}" se guardó correctamente!`);
          }
          stopEdit();
          giftName.focus();
          await loadGifts();
        } catch (err) {
          if (err.status === 404) { toast(err.message, 'error'); stopEdit(); await loadGifts(); return; }
          if (/enlace/i.test(err.message)) markInvalid(giftLink);
          toast(err.message, 'error');
        }
      });
    });

    $('#change-person').addEventListener('click', reset);

    function reset() {
      person = null;
      stopEdit();
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
          ? person.gifts.map((g, i) => renderGiftItem(g, i))
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

    let tab = 'opciones';
    try { tab = sessionStorage.getItem('intercambio_admin_tab') || 'opciones'; } catch { /* sin almacenamiento */ }

    function showLogin() {
      adminDraw.stop();
      panel.hidden = true; loginCard.hidden = false;
      $('#admin-password').value = '';
      setTimeout(() => $('#admin-password').focus(), 50);
    }

    async function showPanel() {
      loginCard.hidden = true; panel.hidden = false;
      await showTab(tab);
    }

    /** Pestañas del panel: opciones de regalo (original), reglas y asignaciones. */
    async function showTab(name) {
      if (!['opciones', 'reglas', 'asignaciones'].includes(name)) name = 'opciones';
      tab = name;
      try { sessionStorage.setItem('intercambio_admin_tab', name); } catch { /* sin almacenamiento */ }
      document.querySelectorAll('.admin-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
      document.querySelectorAll('.admin-tabpanel').forEach((p) => { p.hidden = p.dataset.tabpanel !== name; });
      if (name !== 'asignaciones') adminDraw.stop();
      if (name === 'opciones') await load();
      else if (name === 'reglas') await adminRules.load();
      else adminDraw.start();
    }

    document.querySelectorAll('.admin-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

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
                giftLinkButton(g.link),
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
      adminDraw.stop();
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
      leave() { adminDraw.stop(); },
      handleError,
    };
  })();

  /* ==========================================================
     Panel del dueño: Reglas del intercambio
     ========================================================== */
  const adminRules = (() => {
    const tabPanel = document.querySelector('[data-tabpanel="reglas"]');
    const famInput = $('#family-name');
    const famSubmit = $('#family-form button[type="submit"]');
    let data = null;
    let editingFamily = null;

    async function load() {
      try { data = await api.rules(); render(); } catch (err) { admin.handleError(err); }
    }

    const personName = (id) => data.people.find((p) => p.id === id)?.name || '¿?';

    function render() {
      const locked = data.locked;
      $('#rules-locked').hidden = !locked;

      // Familias
      $('#family-list').replaceChildren(...(data.families.length ? data.families.map((f) => el('li', { class: 'chip' },
        el('span', { class: 'chip-name', text: f.name }),
        el('span', { class: 'badge', text: f.members, title: plural(f.members, 'miembro', 'miembros') }),
        el('button', { type: 'button', class: 'icon-btn icon-btn-edit', title: 'Cambiar nombre', 'aria-label': `Cambiar nombre de ${f.name}`, onclick: () => startRename(f) }, svg(ICON_EDIT)),
        el('button', { type: 'button', class: 'icon-btn', title: 'Eliminar familia', 'aria-label': `Eliminar ${f.name}`, onclick: () => removeFamily(f) }, svg(ICON_TRASH))))
        : [el('li', { class: 'empty-msg', text: 'Aún no hay familias. Crea la primera arriba.' })]));

      // Participantes y su familia
      $('#member-list').replaceChildren(...(data.people.length ? data.people.map((p) => {
        const select = el('select', { 'aria-label': `Familia de ${p.name}` },
          el('option', { value: '', text: 'Sin familia' }),
          data.families.map((f) => el('option', { value: f.id, text: f.name, selected: f.id === p.familyId })));
        select.addEventListener('change', () => setFamily(p, select));
        return el('li', { class: 'member' }, avatar(p.name), el('span', { class: 'member-name', text: p.name }), select);
      }) : [el('li', { class: 'empty-msg', text: 'Aún no hay participantes registrados.' })]));

      // Regla general
      $('#rule-family').checked = data.avoidSameFamily;

      // Restricciones particulares
      const options = () => [el('option', { value: '', text: 'Elige…' }), data.people.map((p) => el('option', { value: p.id, text: p.name }))];
      const g = $('#restr-giver'); const r = $('#restr-receiver');
      const gv = g.value; const rv = r.value;
      g.replaceChildren(...options()); r.replaceChildren(...options());
      g.value = gv; r.value = rv;
      $('#restriction-list').replaceChildren(...(data.restrictions.length ? data.restrictions.map((x) => el('li', { class: 'restriction' },
        el('span', { class: 'restr-text' },
          el('strong', { text: personName(x.giverId) }),
          el('span', { class: 'restr-sign', text: x.mutual ? ' ⇄ ' : ' → ' }),
          el('strong', { text: personName(x.receiverId) }),
          el('small', { text: x.mutual ? ' (no se regalan entre ellos)' : ' (no le regala)' })),
        el('button', { type: 'button', class: 'icon-btn', title: 'Eliminar restricción', 'aria-label': 'Eliminar restricción', onclick: () => removeRestriction(x) }, svg(ICON_TRASH))))
        : [el('li', { class: 'empty-msg', text: 'No hay restricciones particulares.' })]));

      // Con el sorteo generado, todo queda bloqueado (también lo impide el servidor).
      tabPanel.querySelectorAll('input, select, button').forEach((c) => {
        if (c.id !== 'check-feasibility') c.disabled = locked;
      });
      tabPanel.classList.toggle('is-locked', locked);
    }

    function startRename(f) {
      editingFamily = f;
      famInput.value = f.name;
      famSubmit.textContent = 'Guardar nombre';
      famInput.focus();
    }
    function stopRename() { editingFamily = null; famInput.value = ''; famSubmit.textContent = 'Crear familia'; }

    $('#family-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = famInput.value.trim();
      if (!name) { markInvalid(famInput); toast('Escribe el nombre de la familia.', 'error'); return; }
      withBusy(famSubmit, async () => {
        try {
          await api.saveFamily(editingFamily?.id || 0, name);
          toast(editingFamily ? 'Nombre actualizado.' : `Familia "${name}" creada.`);
          stopRename();
          await load();
        } catch (err) { admin.handleError(err); }
      });
    });
    famInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editingFamily) stopRename(); });

    async function removeFamily(f) {
      const ok = await confirmDialog('¿Eliminar familia?',
        `Se eliminará "${f.name}". Sus ${plural(f.members, 'miembro quedará', 'miembros quedarán')} sin familia (no se borra a nadie).`, 'Sí, eliminar');
      if (!ok) return;
      try { await api.deleteFamily(f.id); toast(`Se eliminó "${f.name}".`); } catch (err) { admin.handleError(err); }
      if (editingFamily?.id === f.id) stopRename();
      await load();
    }

    async function setFamily(p, select) {
      select.disabled = true;
      try {
        await api.setFamily(p.id, Number(select.value) || null);
        toast(`${p.name}: ${select.value ? select.selectedOptions[0].textContent : 'sin familia'}.`);
      } catch (err) { admin.handleError(err); }
      await load();
    }

    $('#rule-family').addEventListener('change', async (e) => {
      try {
        await api.setRule(e.target.checked);
        toast(e.target.checked ? 'Regla activada: nadie le regalará a su propia familia.' : 'Regla desactivada.', 'info');
      } catch (err) { admin.handleError(err); }
      await load();
    });

    $('#restriction-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const g = Number($('#restr-giver').value);
      const r = Number($('#restr-receiver').value);
      if (!g) { markInvalid($('#restr-giver')); toast('Elige a la primera persona.', 'error'); return; }
      if (!r) { markInvalid($('#restr-receiver')); toast('Elige a la segunda persona.', 'error'); return; }
      if (g === r) { markInvalid($('#restr-receiver')); toast('Elige a dos personas distintas.', 'error'); return; }
      withBusy(e.submitter || $('#restriction-form button'), async () => {
        try {
          await api.addRestriction(g, r, $('#restr-mutual').checked);
          toast('Restricción agregada.');
          $('#restr-giver').value = ''; $('#restr-receiver').value = '';
          await load();
        } catch (err) { admin.handleError(err); }
      });
    });

    async function removeRestriction(x) {
      try { await api.deleteRestriction(x.id); toast('Restricción eliminada.'); } catch (err) { admin.handleError(err); }
      await load();
    }

    $('#check-feasibility').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const box = $('#feasibility-result');
      try {
        const f = await api.feasibility();
        box.hidden = false;
        box.className = `check-result ${f.possible ? 'ok' : 'bad'}`;
        box.replaceChildren(...[
          el('strong', { text: f.possible ? '✅ Sí es posible hacer el sorteo con estas reglas.' : '❌ No es posible hacer el sorteo con estas reglas.' }),
          f.possible && f.stats
            ? el('p', { text: `${plural(f.stats.participants, 'participante', 'participantes')}. Cada persona tiene entre ${f.stats.minOptions} y ${f.stats.maxOptions} destinatarios posibles.` })
            : null,
          f.problems.length ? el('ul', {}, f.problems.map((p) => el('li', { text: p }))) : null,
          f.possible ? null : el('p', { text: 'Ajusta las familias o las restricciones e intenta de nuevo.' })].filter(Boolean));
      } catch (err) { admin.handleError(err); }
    }));

    return { load };
  })();

  /* ==========================================================
     Panel del dueño: Asignaciones del intercambio
     ========================================================== */
  const adminDraw = (() => {
    let data = null;
    let timer = null;
    const search = $('#as-search');
    const statusSel = $('#as-status');
    const familySel = $('#as-family');
    const NO_FAMILY = '__none__';

    async function load({ quiet = false } = {}) {
      try {
        data = await api.assignments();
        render();
      } catch (err) { if (!quiet || err.status === 401) admin.handleError(err); }
    }

    function start() {
      stop();
      load();
      // Se actualiza solo mientras la pestaña está a la vista.
      timer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, 15000);
    }
    function stop() { clearInterval(timer); timer = null; }

    function render() {
      const { draw, stats, validation } = data;
      const state = $('#draw-state');
      if (!draw) {
        state.className = 'draw-state none';
        state.textContent = 'Todavía no hay sorteo. Revisa las reglas y presiona “Generar sorteo”.';
      } else if (draw.active) {
        state.className = 'draw-state active';
        state.textContent = `🟢 Ruleta activa: los participantes ya pueden descubrir su resultado. (Sorteo generado el ${formatDateTime(draw.createdAt)})`;
      } else {
        state.className = 'draw-state paused';
        state.textContent = `🔒 Sorteo generado el ${formatDateTime(draw.createdAt)}. La ruleta está desactivada.`;
      }

      $('#as-participants').textContent = stats.participants;
      $('#as-assignments').textContent = stats.assignments;
      $('#as-revealed').textContent = stats.revealed;
      $('#as-pending').textContent = stats.pending;
      const vt = $('#as-valid');
      vt.textContent = !validation ? '—' : validation.valid ? '✅ Válido' : '⚠️ Con errores';
      vt.className = !validation ? '' : validation.valid ? 'ok' : 'bad';

      $('#draw-generate').hidden = !!draw;
      for (const id of ['draw-validate', 'draw-download', 'draw-pending', 'draw-reset']) $(`#${id}`).hidden = !draw;
      $('#draw-activate').hidden = !draw || draw.active;
      $('#draw-deactivate').hidden = !draw || !draw.active;
      if (validation && (!validation.valid || validation.warnings.length)) renderValidation(validation);
      if (!draw) $('#validation-result').hidden = true;

      // Filtro de familias
      const families = [...new Set(data.rows.flatMap((r) => [r.giverFamily, r.receiverFamily]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      const prev = familySel.value;
      familySel.replaceChildren(el('option', { value: '', text: 'Todas las familias' }),
        families.map((f) => el('option', { value: f, text: f })), el('option', { value: NO_FAMILY, text: 'Sin familia' }));
      familySel.value = [...familySel.options].some((o) => o.value === prev) ? prev : '';

      renderRows();
      renderLog();
    }

    function renderRows() {
      const tbody = $('#as-rows');
      if (!data?.draw) {
        tbody.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty-cell', text: 'Aún no se ha generado el sorteo.' })));
        $('#as-foot').textContent = '';
        return;
      }
      const terms = normalize(search.value).split(' ').filter(Boolean);
      const st = statusSel.value;
      const fam = familySel.value;
      const shown = data.rows.filter((r) => {
        if (st === 'pendiente' && r.revealedAt) return false;
        if (st === 'revelado' && !r.revealedAt) return false;
        if (fam === NO_FAMILY && r.giverFamily) return false;
        if (fam && fam !== NO_FAMILY && r.giverFamily !== fam) return false;
        const hay = normalize(`${r.giverName} ${r.receiverName}`);
        return terms.every((t) => hay.includes(t));
      });
      tbody.replaceChildren(...(shown.length ? shown.map((r) => el('tr', {},
        el('td', { 'data-label': 'Participante' }, el('strong', { text: r.giverName })),
        el('td', { 'data-label': 'Familia', text: r.giverFamily || '—' }),
        el('td', { 'data-label': 'Le toca regalar a', text: r.receiverName }),
        el('td', { 'data-label': 'Familia del destinatario', text: r.receiverFamily || '—' }),
        el('td', { 'data-label': 'Estado' }, el('span', { class: `status ${r.revealedAt ? 'done' : 'wait'}`, text: r.revealedAt ? 'Revelado' : 'Pendiente' })),
        el('td', { 'data-label': 'Fecha y hora', text: r.revealedAt ? formatDateTime(r.revealedAt) : '—' })))
        : [el('tr', {}, el('td', { colspan: 6, class: 'empty-cell', text: 'Nadie coincide con los filtros.' }))]));
      $('#as-foot').textContent = `Mostrando ${shown.length} de ${data.rows.length}. Se actualiza automáticamente.`;
    }

    const LOG_LABEL = {
      sorteo_generado: '🎲 Sorteo generado', ruleta_activada: '▶️ Ruleta activada', ruleta_desactivada: '⏸️ Ruleta desactivada',
      intercambio_reiniciado: '♻️ Intercambio reiniciado', descarga: '📥 Asignaciones descargadas', codigo_regenerado: '🔑 Código regenerado',
    };
    function renderLog() {
      $('#log-list').replaceChildren(...(data.log.length ? data.log.map((l) => el('li', {},
        el('span', { class: 'log-when', text: formatDateTime(l.createdAt) }),
        el('strong', { text: LOG_LABEL[l.action] || l.action }),
        l.detail ? el('span', { class: 'log-detail', text: l.detail }) : null))
        : [el('li', { class: 'empty-msg', text: 'Sin operaciones registradas.' })]));
    }

    function renderValidation(v) {
      const box = $('#validation-result');
      box.hidden = false;
      box.className = `check-result ${v.valid ? 'ok' : 'bad'}`;
      box.replaceChildren(...[
        el('strong', { text: v.valid ? '✅ El sorteo es válido.' : '⚠️ El sorteo tiene inconsistencias.' }),
        el('ul', { class: 'checks' }, v.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'bad', text: `${c.ok ? '✔' : '✘'} ${c.label}` }))),
        v.errors.length ? el('ul', {}, v.errors.map((e) => el('li', { text: e }))) : null,
        v.warnings?.length ? el('p', { class: 'warn', text: `ℹ️ ${v.warnings.join(' ')}` }) : null].filter(Boolean));
    }

    function renderProblems(title, problems) {
      const box = $('#validation-result');
      box.hidden = false;
      box.className = 'check-result bad';
      box.replaceChildren(el('strong', { text: title }),
        el('ul', {}, (problems || []).map((p) => el('li', { text: p }))),
        el('p', { text: 'Ajusta las reglas en la pestaña “Reglas del intercambio” y vuelve a intentarlo.' }));
    }

    search.addEventListener('input', debounce(renderRows, 120));
    statusSel.addEventListener('change', renderRows);
    familySel.addEventListener('change', renderRows);

    // Generar sorteo
    $('#draw-generate').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ok = await confirmDialog('¿Generar el sorteo?',
        'Se asignará al azar a quién le regala cada participante registrado, respetando las reglas. '
        + 'El resultado queda guardado y las reglas se bloquean: la única forma de cambiarlo será reiniciar el intercambio.',
        'Sí, generar');
      if (!ok) return;
      const id = requestId(); // el mismo id en los reintentos evita resultados adicionales
      await withBusy(btn, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await api.generateDraw(id);
            toast(`¡Sorteo generado para ${plural(r.participants, 'participante', 'participantes')}! Revisa la validación y activa la ruleta.`);
            break;
          } catch (err) {
            if (err.status === 0 && attempt < 2) { await new Promise((res) => setTimeout(res, 1200)); continue; }
            if (err.status === 422) { renderProblems(`❌ ${err.message}`, err.data?.problems); toast('No es posible hacer el sorteo con estas reglas.', 'error'); } else admin.handleError(err);
            break;
          }
        }
        await load();
        if (data?.validation) renderValidation(data.validation);
      });
    });

    $('#draw-validate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      try {
        const { validation } = await api.validateDraw();
        renderValidation(validation);
        toast(validation.valid ? 'El sorteo es válido. ✅' : 'El sorteo tiene inconsistencias.', validation.valid ? 'ok' : 'error');
      } catch (err) { admin.handleError(err); }
    }));

    $('#draw-activate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      try {
        await api.setDrawActive(true);
        toast('¡La ruleta está activa! Ya pueden girar. 🎡');
      } catch (err) {
        if (err.data?.validation) renderValidation(err.data.validation);
        admin.handleError(err);
      }
      await load();
    }));

    $('#draw-deactivate').addEventListener('click', async (e) => {
      const ok = await confirmDialog('¿Desactivar la ruleta?',
        'Nadie más podrá revelar su resultado hasta que la vuelvas a activar. Las asignaciones se conservan y quienes ya giraron pueden seguir consultando su resultado.',
        'Sí, desactivar');
      if (!ok) return;
      await withBusy(e.currentTarget, async () => {
        try { await api.setDrawActive(false); toast('Ruleta desactivada.', 'info'); } catch (err) { admin.handleError(err); }
        await load();
      });
    });

    $('#draw-download').addEventListener('click', () => authDialog({
      title: 'Descargar asignaciones',
      text: 'Por seguridad, escribe de nuevo la contraseña del dueño. El archivo incluye todas las asignaciones (reveladas y pendientes).',
      okLabel: 'Descargar', withFormat: true,
      async onSubmit({ password, format }) {
        const r = await api.exportDraw(password, format);
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        const a = el('a', { href: url, download: r.filename });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        if (r.valid) toast('Archivo descargado. ✅ El sorteo es válido.');
        else {
          toast('⚠️ El sorteo tiene inconsistencias: el archivo está marcado como NO VÁLIDO.', 'error');
          renderProblems('⚠️ El archivo se marcó como NO VÁLIDO por estas inconsistencias:', r.errors);
        }
        load({ quiet: true });
      },
    }));

    $('#draw-reset').addEventListener('click', async () => {
      if (!data?.draw) return;
      const ok = await confirmDialog('¿Reiniciar el intercambio?',
        `Se eliminarán las ${data.stats.assignments} asignaciones del sorteo actual (${data.stats.revealed} ya fueron reveladas). `
        + 'Quienes ya giraron perderán su resultado y habrá que hacer un sorteo nuevo. Las opciones de regalo no se tocan.',
        'Entiendo, continuar');
      if (!ok) return;
      const drawId = data.draw.id;
      const done = await authDialog({
        title: 'Confirmar reinicio',
        text: 'Esta acción no se puede deshacer y quedará registrada en el historial.',
        okLabel: 'Reiniciar intercambio', confirmWord: 'REINICIAR',
        async onSubmit({ password, confirm }) { await api.resetDraw(password, drawId, confirm); },
      });
      if (done) {
        toast('El intercambio se reinició. Las reglas ya se pueden modificar.', 'info');
        $('#validation-result').hidden = true;
      }
      await load();
    });

    $('#draw-pending').addEventListener('click', () => {
      statusSel.value = 'pendiente';
      search.value = ''; familySel.value = '';
      renderRows();
      const pending = data.rows.filter((r) => !r.revealedAt).map((r) => r.giverName);
      toast(pending.length ? `Faltan ${pending.length}: ${pending.join(', ')}.` : '¡Todos ya giraron la ruleta! 🎉', 'info');
      $('.as-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Códigos de acceso
    async function loadCodes() {
      const list = $('#code-list');
      list.replaceChildren(el('li', { class: 'loading', text: 'Cargando…' }));
      try {
        const { codes } = await api.codes();
        const hasDraw = !!data?.draw;
        list.replaceChildren(...(codes.length ? codes.map((c) => el('li', { class: 'code-item' },
          avatar(c.name),
          el('span', { class: 'member-name' }, c.name, hasDraw && !c.inDraw ? el('small', { text: ' (no está en el sorteo actual)' }) : null),
          el('code', { class: 'code', text: c.code }),
          el('button', {
            type: 'button', class: 'btn btn-ghost btn-small', title: 'Copiar un mensaje con el código para enviarlo',
            onclick: async () => {
              const msg = `🎄 Hola ${c.name}: tu código para la Ruleta del intercambio es ${c.code}. Entra a ${location.origin}${location.pathname}#/ruleta`;
              toast((await copyText(msg)) ? `Mensaje para ${c.name} copiado.` : 'No se pudo copiar; cópialo a mano.', 'info');
            },
          }, 'Copiar mensaje'),
          el('button', {
            type: 'button', class: 'icon-btn icon-btn-edit', title: 'Generar un código nuevo', 'aria-label': `Generar un código nuevo para ${c.name}`,
            onclick: async () => {
              const ok = await confirmDialog('¿Cambiar el código?', `El código actual de ${c.name} dejará de funcionar. Su resultado no cambia.`, 'Sí, cambiar');
              if (!ok) return;
              try { await api.regenerateCode(c.id); toast(`Nuevo código para ${c.name}.`); } catch (err) { admin.handleError(err); }
              loadCodes();
            },
          }, svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'))))
          : [el('li', { class: 'empty-msg', text: 'Aún no hay participantes.' })]));
      } catch (err) { admin.handleError(err); }
    }
    $('#codes-card').addEventListener('toggle', (e) => { if (e.target.open) loadCodes(); });

    return { start, stop, load };
  })();

  /* ==========================================================
     Vista: Ruleta del intercambio
     ----------------------------------------------------------
     La ruleta es solo una animación: el destinatario ya está
     guardado en el servidor desde que el dueño generó el sorteo.
     El navegador nunca lo conoce antes de girar y no puede
     cambiarlo: el servidor siempre responde el mismo nombre.
     ========================================================== */
  const ruleta = (() => {
    const steps = {
      closed: $('#ruleta-closed'), who: $('#ruleta-step-who'), code: $('#ruleta-step-code'), stage: $('#ruleta-stage'),
    };
    const rotor = $('#wheel-rotor');
    const spinBtn = $('#spin-btn');
    const hint = $('#wheel-hint');
    const pointer = document.querySelector('.wheel-pointer');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let participants = [];
    let selected = null;
    let me = null;
    let segments = [];
    let rot = 0;
    let spinning = false;

    function show(step) {
      for (const [k, node] of Object.entries(steps)) node.hidden = k !== step;
    }

    const search = setupPersonSearch({
      input: $('#ruleta-search'),
      list: $('#ruleta-results'),
      showAllWhenEmpty: true,
      emptyText: (q) => `No encontramos a "${q}" entre los participantes del sorteo.`,
      source: async (query) => {
        const terms = normalize(query).split(' ').filter(Boolean);
        return participants.filter((p) => terms.every((t) => normalize(p.name).includes(t)));
      },
      meta: () => null,
      onSelect: (p) => pickPerson(p),
    });

    async function loadStatus() {
      try {
        const st = await api.ruletaStatus();
        if (!st.hasDraw) { show('closed'); return; }
        participants = st.participants;
        $('#ruleta-who-hint').textContent = st.active
          ? 'Busca y selecciona tu nombre.'
          : '⏸️ La ruleta está en pausa por ahora. Si ya giraste, puedes entrar para consultar tu resultado.';
        show('who');
        search.reset();
        search.refresh();
        setTimeout(() => $('#ruleta-search').focus(), 50);
      } catch (err) { toast(err.message, 'error'); }
    }

    function pickPerson(p) {
      selected = p;
      $('#ruleta-code-name').textContent = p.name;
      setAvatar($('#ruleta-code-avatar'), p.name);
      $('#ruleta-code').value = '';
      show('code');
      setTimeout(() => $('#ruleta-code').focus(), 50);
    }

    $('#ruleta-change').addEventListener('click', () => { selected = null; loadStatus(); });

    $('#ruleta-code-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#ruleta-code');
      const code = input.value.replace(/[^a-z0-9]/gi, '');
      if (!code) { markInvalid(input); toast('Escribe tu código de acceso.', 'error'); return; }
      withBusy(e.submitter || $('#ruleta-code-form button'), async () => {
        try {
          await api.ruletaLogin(selected.id, code);
          input.value = '';
          await loadMe();
        } catch (err) { markInvalid(input); toast(err.message, 'error'); }
      });
    });

    function handleError(err) {
      toast(err.message, 'error');
      if (err.data?.code === 'session' || err.data?.code === 'no_draw') { playerToken.set(''); me = null; loadStatus(); }
    }

    async function loadMe() {
      me = await api.ruletaMe();
      show('stage');
      $('#ruleta-person-name').textContent = me.person.name;
      setAvatar($('#ruleta-avatar'), me.person.name);
      $('#ruleta-gifts').hidden = true;
      buildWheel(me.wheel);
      if (me.revealed) {
        setRot(targetAngle(me.recipient.id, 0));
        markWinner(me.recipient.id);
        spinBtn.hidden = true;
        hint.textContent = 'Ya giraste la ruleta. Tu resultado quedó guardado:';
        showResult(me.recipient, me.revealedAt, false);
      } else {
        setRot(Math.random() * 360);
        $('#ruleta-result').hidden = true;
        spinBtn.hidden = false;
        spinBtn.disabled = !me.active;
        hint.textContent = me.active
          ? 'Presiona el botón para descubrir a quién le regalas este año.'
          : '⏸️ La ruleta está en pausa. Vuelve a intentarlo más tarde.';
      }
    }

    /* ---------- Dibujo de la ruleta (SVG) ---------- */
    const R = 196;
    const COLORS = [['#c1272d', '#fff'], ['#1d6b45', '#fff'], ['#d9a531', '#3b2a05'], ['#fffaf0', '#1d6b45']];
    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const polar = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];

    function buildWheel(list) {
      segments = list;
      const n = list.length;
      const a = 360 / n;
      const fs = n <= 6 ? 18 : n <= 10 ? 15 : n <= 16 ? 13 : n <= 24 ? 11 : 9;
      const maxChars = Math.floor(138 / (fs * 0.56));
      rotor.replaceChildren();
      list.forEach((p, i) => {
        let color = COLORS[i % 4];
        if (n > 1 && i === n - 1 && i % 4 === 0) color = COLORS[1]; // evita dos colores iguales juntos
        const g = svgEl('g', { class: 'seg', 'data-id': p.id });
        if (n === 1) g.append(svgEl('circle', { r: R, fill: color[0] }));
        else {
          const [x1, y1] = polar(i * a - a / 2, R);
          const [x2, y2] = polar(i * a + a / 2, R);
          g.append(svgEl('path', { d: `M0 0 L${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`, fill: color[0] }));
        }
        const label = p.name.length > maxChars ? `${p.name.slice(0, maxChars - 1).trim()}…` : p.name;
        const t = svgEl('text', {
          x: (R + 38) / 2, y: fs * 0.35, 'text-anchor': 'middle', fill: color[1], 'font-size': fs,
          transform: `rotate(${(i * a - 90).toFixed(3)})`,
        });
        t.textContent = label;
        g.append(t);
        rotor.append(g);
      });
      // Separadores y borde
      if (n > 1) {
        for (let i = 0; i < n; i++) {
          const [x, y] = polar(i * a - a / 2, R);
          rotor.append(svgEl('line', { x1: 0, y1: 0, x2: x.toFixed(2), y2: y.toFixed(2), class: 'seg-line' }));
        }
      }
      rotor.append(svgEl('circle', { r: R, class: 'wheel-rim' }));
      for (let i = 0; i < 24; i++) {
        const [x, y] = polar(i * 15, R + 7);
        rotor.append(svgEl('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: 3.4, class: `bulb b${i % 3}` }));
      }
    }

    function setRot(deg) {
      rot = deg;
      rotor.setAttribute('transform', `rotate(${(deg % 360).toFixed(3)})`);
    }
    const mod = (x, m) => ((x % m) + m) % m;
    const segAngle = () => 360 / segments.length;

    /** Ángulo (0–360) en el que el segmento del destinatario queda bajo el puntero. */
    function targetAngle(id, jitter) {
      const i = segments.findIndex((s) => s.id === id);
      return mod(-(i * segAngle()) + jitter, 360);
    }

    function markWinner(id) {
      rotor.querySelectorAll('.seg').forEach((g) => g.classList.toggle('win', Number(g.dataset.id) === id));
    }

    let lastSeg = -1;
    function tickPointer() {
      const idx = Math.floor(mod(-rot + segAngle() / 2, 360) / segAngle());
      if (idx !== lastSeg) {
        lastSeg = idx;
        pointer.classList.remove('tick');
        void pointer.offsetWidth;
        pointer.classList.add('tick');
      }
    }

    /**
     * Gira: acelera mientras el servidor confirma el resultado guardado y
     * luego desacelera suavemente hasta detenerse en ese nombre.
     */
    function spin() {
      if (spinning || !me || me.revealed) return;
      spinning = true;
      spinBtn.disabled = true;
      markWinner(null);
      hint.textContent = '🎶 Girando…';
      const vmax = 900; // grados por segundo
      const minFree = reduceMotion ? 300 : 1600;
      let speed = 0;
      let phase = 'free';
      let result = null;
      let error = null;
      let decel = null;
      const start = performance.now();
      let last = start;

      api.ruletaSpin().then((r) => { result = r; }, (e) => { error = e; });

      function planStop(now, target) {
        const base = mod(target - rot, 360);
        const D = target == null ? speed * 0.35 : base + 360 * (reduceMotion ? 0 : 3);
        decel = { t0: now, from: rot, D, T: Math.max(0.6, (3 * D) / Math.max(speed, 1)) };
        phase = 'decel';
      }

      function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (phase === 'free') {
          speed = Math.min(vmax, speed + (vmax * dt) / 0.7);
          setRot(rot + speed * dt);
          if (error) planStop(now, null);
          else if (result && now - start >= minFree && speed >= vmax) {
            const id = result.recipient.id;
            if (!segments.some((s) => s.id === id)) { error = new Error('No se pudo mostrar la ruleta. Recarga la página.'); planStop(now, null); } else {
              const jitter = (Math.random() - 0.5) * segAngle() * 0.6;
              planStop(now, targetAngle(id, jitter));
            }
          }
        } else {
          const t = Math.min(1, (now - decel.t0) / (decel.T * 1000));
          setRot(decel.from + decel.D * (1 - (1 - t) ** 3)); // ease-out: sin saltos de velocidad
          if (t >= 1) { finish(); return; }
        }
        tickPointer();
        requestAnimationFrame(frame);
      }

      function finish() {
        spinning = false;
        if (error) {
          spinBtn.disabled = false;
          hint.textContent = 'Algo falló. Intenta de nuevo: tu resultado no cambiará.';
          handleError(error);
          if (error.data?.code === 'paused') { spinBtn.disabled = true; hint.textContent = '⏸️ La ruleta está en pausa. Vuelve más tarde.'; }
          return;
        }
        me.revealed = true;
        me.recipient = result.recipient;
        me.revealedAt = result.revealedAt;
        markWinner(result.recipient.id);
        spinBtn.hidden = true;
        hint.textContent = '¡La ruleta se detuvo!';
        showResult(result.recipient, result.revealedAt, true);
      }

      requestAnimationFrame(frame);
    }

    function showResult(recipient, revealedAt, celebrate) {
      const box = $('#ruleta-result');
      $('#result-msg').replaceChildren('🎄 ¡Felicidades! Este año te toca darle un regalo a ',
        el('strong', { text: recipient.name }), '. 🎁');
      $('#result-date').textContent = revealedAt ? `Resultado revelado el ${formatDateTime(revealedAt)}.` : '';
      box.hidden = false;
      box.classList.remove('pop'); void box.offsetWidth;
      if (celebrate) {
        box.classList.add('pop');
        confetti();
        setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
      }
    }

    spinBtn.addEventListener('click', spin);

    $('#see-gifts').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      try {
        const { recipient } = await api.ruletaGifts();
        $('#ruleta-gifts-name').textContent = recipient.name;
        setAvatar($('#ruleta-gifts-avatar'), recipient.name);
        $('#ruleta-gifts-count').textContent = plural(recipient.gifts.length, 'opción', 'opciones');
        // Solo lectura: aquí nadie puede modificar las opciones de otra persona.
        $('#ruleta-gift-list').replaceChildren(...(recipient.gifts.length
          ? recipient.gifts.map((g, i) => renderGiftItem(g, i))
          : [el('li', { class: 'empty-msg', text: `${recipient.name} todavía no ha registrado opciones de regalo. Vuelve a consultar más adelante. 🎄` })]));
        $('#ruleta-gifts').hidden = false;
        $('#ruleta-gifts').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { handleError(err); }
    }));

    $('#ruleta-logout').addEventListener('click', async () => {
      if (spinning) return;
      try { await api.ruletaLogout(); } catch { /* ignorar */ }
      me = null;
      toast('Saliste de la ruleta.', 'info');
      loadStatus();
    });

    /* ---------- Confeti ---------- */
    function confetti() {
      if (reduceMotion) return;
      const canvas = el('canvas', { class: 'confetti', 'aria-hidden': 'true' });
      document.body.append(canvas);
      const ctx = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth; const h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const colors = ['#e63946', '#2a8a5c', '#f4c95d', '#ffffff', '#57d38c'];
      const parts = Array.from({ length: 170 }, (_, i) => ({
        x: w / 2 + (Math.random() - 0.5) * 80, y: h * 0.45,
        vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5,
        s: Math.random() * 7 + 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        c: colors[i % colors.length], star: i % 7 === 0,
      }));
      const t0 = performance.now();
      (function frame(now) {
        const t = (now - t0) / 1000;
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 2.6) / 1.2);
        for (const p of parts) {
          p.vy += 0.38; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
          if (p.star) { ctx.font = `${p.s * 2.4}px serif`; ctx.fillText('★', 0, 0); } else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
          ctx.restore();
        }
        if (t < 3.8) requestAnimationFrame(frame); else canvas.remove();
      })(t0);
    }

    return {
      async enter() {
        if (spinning) return;
        if (playerToken.get()) {
          try { await loadMe(); return; } catch (err) {
            if (err.data?.code === 'session' || err.data?.code === 'no_draw') playerToken.set('');
            else { toast(err.message, 'error'); }
          }
        }
        await loadStatus();
      },
    };
  })();

  /* ==========================================================
     Navegación (hash)
     ========================================================== */
  const ROUTES = { '': 'home', agregar: 'agregar', ver: 'ver', dueno: 'dueno', ruleta: 'ruleta' };
  const ENTER = { agregar: add.enter, ver: view.enter, dueno: admin.enter, ruleta: ruleta.enter };

  function route() {
    const key = location.hash.replace(/^#\/?/, '').split('/')[0];
    const name = ROUTES[key] || 'home';
    if (name !== 'dueno') admin.leave();
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    window.scrollTo(0, 0);
    ENTER[name]?.();
  }
  window.addEventListener('hashchange', route);
  route();

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
