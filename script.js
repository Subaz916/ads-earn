/* =============================================================
   Ad Manager — vanilla JS (no frameworks, no backend)
   Stores authorized ad-network embed codes and renders 100 slots.
   ============================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     CONSTANTS
     ------------------------------------------------------------------ */
  const TOTAL_SLOTS = 100;                 // number of ad slots on the display page
  const STORAGE_KEY = 'ads_config';        // localStorage key for the configuration
  const FILE_NAME = 'ads.json';            // export / import file name
  const MAX_ADS = 100;                     // hard cap on stored ad entries

  /* Fallback used the very first time the app runs (no localStorage yet). */
  const DEFAULT_CONFIG = {
    ads: [
      { id: 1, name: 'Ad 1', embedCode: '' },
      { id: 2, name: 'Ad 2', embedCode: '' }
    ]
  };

  /* ------------------------------------------------------------------
     STATE
     ------------------------------------------------------------------ */
  let ads = [];            // working copy of the configuration
  let editingId = null;    // id of the ad loaded in the editor (null = new ad)
  let nextId = 1;          // id generator
  let sortBySlot = false;
  let modalResolve = null;

  /* ------------------------------------------------------------------
     DOM
     ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const el = {
    body: document.body,
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    menuBtn: $('#menuBtn'),
    pageTitle: $('#pageTitle'),
    pageSub: $('#pageSub'),

    statTotal: $('#statTotal'),
    statFilled: $('#statFilled'),
    statEmpty: $('#statEmpty'),
    storageMode: $('#storageMode'),

    adTableBody: $('#adTableBody'),
    adTableEmpty: $('#adTableEmpty'),
    adSearch: $('#adSearch'),
    sortBySlot: $('#sortBySlot'),

    editorMode: $('#editorMode'),
    adName: $('#adName'),
    adSlot: $('#adSlot'),
    adCode: $('#adCode'),
    fillAllSlots: $('#fillAllSlots'),
    editorStatus: $('#editorStatus'),
    btnSave: $('#btnSave'),
    btnAddAd: $('#btnAddAd'),
    btnEdit: $('#btnEdit'),
    btnDelete: $('#btnDelete'),
    btnPreview: $('#btnPreview'),

    previewBox: $('#previewBox'),
    previewSlot: $('#previewSlot'),
    closePreview: $('#closePreview'),

    btnSaveLocal: $('#btnSaveLocal'),
    btnDiscard: $('#btnDiscard'),
    btnExport: $('#btnExport'),
    topExport: $('#topExport'),
    btnImport: $('#btnImport'),
    importFile: $('#importFile'),
    btnClearAll: $('#btnClearAll'),
    bulkSource: $('#bulkSource'),
    btnFillEmpty: $('#btnFillEmpty'),
    btnFillAll: $('#btnFillAll'),

    viewAdmin: $('#view-admin'),
    viewDisplay: $('#view-display'),
    topRender: $('#topRender'),
    btnRender: $('#btnRender'),
    btnClearDisplay: $('#btnClearDisplay'),
    slotFilter: $('#slotFilter'),
    displaySearch: $('#displaySearch'),
    autoRender: $('#autoRender'),
    slots: $('#slots'),

    toasts: $('#toasts'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalText: $('#modalText'),
    modalOk: $('#modalOk'),
    modalCancel: $('#modalCancel')
  };

  /* ------------------------------------------------------------------
     UTILITIES
     ------------------------------------------------------------------ */
  function toast(msg, kind) {
    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.textContent = msg;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s, transform .25s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 260);
    }, 2600);
  }

  function setStatus(msg, kind) {
    el.editorStatus.textContent = msg || '';
    el.editorStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  function confirmDialog(title, text) {
    el.modalTitle.textContent = title;
    el.modalText.textContent = text;
    el.modal.hidden = false;
    return new Promise((resolve) => { modalResolve = resolve; });
  }

  function closeModal(result) {
    el.modal.hidden = true;
    if (modalResolve) { modalResolve(result); modalResolve = null; }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }

  function clampSlot(n) {
    const v = parseInt(n, 10);
    if (isNaN(v)) return null;
    return Math.min(TOTAL_SLOTS, Math.max(1, v));
  }

  /* ------------------------------------------------------------------
     SAFE EMBED RENDERER
     ------------------------------------------------------------------
     Parses the supplied ad-network HTML with DOMParser (which never runs
     scripts or loads resources) and then rebuilds the nodes in the live
     document. <script> elements are recreated as fresh, authorized
     script elements so that real ad-network code executes normally.
     The supplied code itself is never modified, obfuscated or bypassed.
     ------------------------------------------------------------------ */
  const writeTargets = [];
  let writeGuardInstalled = false;

  function installWriteGuard() {
    if (writeGuardInstalled) return;
    writeGuardInstalled = true;
    // Some legacy ad tags call document.write(). We never let that wipe the
    // dashboard: the written markup is injected into the current ad slot
    // through the very same safe renderer.
    document.write = function () {
      const target = writeTargets[writeTargets.length - 1];
      const html = Array.prototype.join.call(arguments, '');
      if (target) { adoptString(target, html); return; }
      console.warn('[Ad Manager] document.write() ignored outside of an ad slot.');
    };
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function parseFragment(html) {
    const wrapped =
      '<!doctype html><html><head></head><body><div id="__ad_root__">' +
      html +
      '</div></body></html>';
    const doc = new DOMParser().parseFromString(wrapped, 'text/html');
    if (doc.querySelector('parsererror')) return null;
    return doc.getElementById('__ad_root__');
  }

  /** Recreate a <script> element exactly as supplied, but as a live element. */
  function createLiveScript(oldScript) {
    const s = document.createElement('script');
    for (let i = 0; i < oldScript.attributes.length; i++) {
      const a = oldScript.attributes[i];
      s.setAttribute(a.name, a.value);
    }
    if (!s.hasAttribute('src')) {
      s.textContent = oldScript.textContent;   // inline script body, untouched
    } else {
      s.async = false;                          // keep network/exec order
    }
    return s;
  }

  /** Move the children of `src` into the live node `dest`. */
  function adoptChildren(src, dest) {
    const targetDoc = dest.ownerDocument || document;
    while (src.firstChild) {
      const node = src.firstChild;

      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SCRIPT') {
        dest.appendChild(createLiveScript(node));
        continue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const clone = targetDoc.createElement(node.tagName);
        for (let i = 0; i < node.attributes.length; i++) {
          const a = node.attributes[i];
          clone.setAttribute(a.name, a.value);
        }
        writeTargets.push(clone);
        adoptChildren(node, clone);
        writeTargets.pop();
        dest.appendChild(clone);
        continue;
      }

      // text, comment, doctype, ...
      dest.appendChild(targetDoc.importNode(node, true));
    }
  }

  function adoptString(dest, html) {
    const root = parseFragment(String(html));
    if (!root) return;
    adoptChildren(root, dest);
  }

  /**
   * Render an ad-network embed code into a container element.
   * @param {HTMLElement} target container (e.g. <div class="ad-slot">)
   * @param {string} html the embed code exactly as supplied
   */
  function renderEmbed(target, html) {
    if (!target) return false;
    installWriteGuard();
    clearNode(target);
    if (!html || !String(html).trim()) return false;

    const root = parseFragment(String(html));
    if (!root) {
      target.appendChild(document.createTextNode('Could not parse this embed code.'));
      return false;
    }

    writeTargets.push(target);
    try {
      adoptChildren(root, target);
    } catch (err) {
      console.error('[Ad Manager] embed execution error:', err);
      toast('Embed code error: ' + err.message, 'err');
    } finally {
      writeTargets.pop();
    }
    return true;
  }

  /* ------------------------------------------------------------------
     STORAGE  (localStorage key: ads_config)
     ------------------------------------------------------------------ */
  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.ads) ? raw.ads : []);
    const out = [];
    const usedIds = {};

    list.slice(0, MAX_ADS).forEach(function (item, i) {
      if (!item || typeof item !== 'object') return;
      let id = parseInt(item.id, 10);
      if (isNaN(id) || usedIds[id]) id = i + 1;
      while (usedIds[id]) id++;
      usedIds[id] = true;

      out.push({
        id: id,
        name: String(item.name == null ? 'Ad ' + id : item.name).slice(0, 120),
        embedCode: typeof item.embedCode === 'string' ? item.embedCode : '',
        slot: clampSlot(item.slot != null ? item.slot : item.adNumber)
      });
    });
    return out;
  }

  function buildConfig() {
    // Export shape: { "ads": [ { id, name, embedCode, slot } ] }
    return { ads: ads.map(function (a) {
      return { id: a.id, name: a.name, embedCode: a.embedCode, slot: a.slot };
    }) };
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildConfig()));
      el.storageMode.textContent = 'localStorage';
      return true;
    } catch (err) {
      el.storageMode.textContent = 'unavailable';
      console.warn('[Ad Manager] localStorage write failed:', err);
      toast('Could not save to localStorage: ' + err.message, 'err');
      return false;
    }
  }

  /** Read saved config; on first run fall back to the bundled ads.json. */
  function loadInitial() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        ads = normalize(JSON.parse(saved));
        return;
      } catch (err) {
        console.warn('[Ad Manager] stored config was invalid, using default.', err);
      }
    }
    ads = normalize(DEFAULT_CONFIG);
    fetchSeed();
  }

  /** Best-effort load of ./ads.json (works when served over http/https). */
  function fetchSeed() {
    if (!window.fetch) return;
    fetch(FILE_NAME, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        ads = normalize(data);
        syncNextId();
        persist();
        renderAll();
        renderSlots();
        toast('Loaded configuration from ' + FILE_NAME, 'ok');
      })
      .catch(function () {
        // Opened directly from disk (file://) — keep the built-in defaults.
        renderAll();
        renderSlots();
      });
  }

  function syncNextId() {
    nextId = ads.reduce(function (max, a) { return Math.max(max, a.id); }, 0) + 1;
  }

  /* ------------------------------------------------------------------
     TABLE / STATS
     ------------------------------------------------------------------ */
  function adForSlot(slot) {
    for (let i = 0; i < ads.length; i++) {
      if (ads[i].slot === slot) return ads[i];
    }
    return null;
  }

  function renderStats() {
    const filled = [];
    for (let s = 1; s <= TOTAL_SLOTS; s++) if (adForSlot(s)) filled.push(s);
    el.statTotal.textContent = ads.length;
    el.statFilled.textContent = filled.length;
    el.statEmpty.textContent = TOTAL_SLOTS - filled.length;
  }

  function visibleAds() {
    const q = (el.adSearch.value || '').trim().toLowerCase();
    let list = ads.slice();
    if (sortBySlot) {
      list.sort(function (a, b) { return (a.slot || 0) - (b.slot || 0); });
    }
    if (q) {
      list = list.filter(function (a) {
        return String(a.name).toLowerCase().indexOf(q) !== -1 ||
               String(a.id).indexOf(q) !== -1 ||
               String(a.slot).indexOf(q) !== -1;
      });
    }
    return list;
  }

  function renderTable() {
    const list = visibleAds();
    el.adTableBody.textContent = '';
    el.adTableEmpty.hidden = list.length !== 0;

    list.forEach(function (ad) {
      const tr = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.className = 'mono';
      tdId.textContent = String(ad.id);

      const tdName = document.createElement('td');
      tdName.className = 'name';
      tdName.textContent = ad.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = ad.embedCode.trim() ? 'code provided' : 'no code yet';
      tdName.appendChild(sub);

      const tdSlot = document.createElement('td');
      tdSlot.className = 'mono';
      tdSlot.textContent = ad.slot ? 'Ad ' + ad.slot : '—';

      const tdSize = document.createElement('td');
      tdSize.className = 'mono';
      tdSize.textContent = formatBytes(ad.embedCode.length);

      const tdAct = document.createElement('td');
      const group = document.createElement('div');
      group.className = 'row-actions';
      group.appendChild(rowButton('Edit', 'ghost small', function () { loadIntoEditor(ad.id); }));
      group.appendChild(rowButton('Delete', 'danger small', function () { removeAd(ad.id); }));
      tdAct.appendChild(group);

      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdSlot);
      tr.appendChild(tdSize);
      tr.appendChild(tdAct);
      el.adTableBody.appendChild(tr);
    });
  }

  function rowButton(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ------------------------------------------------------------------
     BULK FILL — push one ad into every slot
     ------------------------------------------------------------------ */
  function createAd(name, embedCode, slot) {
    return { id: nextId++, name: name, embedCode: embedCode, slot: slot };
  }

  /**
   * Replicate one ad into all ad numbers.
   * @param {object}  source     the ad entry to copy
   * @param {boolean} onlyEmpty  true = only fill slots that have no ad yet
   * @returns {number} how many slots were written
   */
  function fillSlotsWith(source, onlyEmpty) {
    let written = 0;
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const existing = adForSlot(s);
      if (onlyEmpty && existing) continue;
      if (existing) ads = ads.filter(function (a) { return a.id !== existing.id; });
      ads.push(createAd(source.name, source.embedCode, s));
      written++;
    }
    return written;
  }

  function renderBulkSource() {
    const prev = el.bulkSource.value;
    el.bulkSource.textContent = '';

    const usable = ads.filter(function (a) { return a.embedCode.trim(); });
    if (!usable.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No ad with code saved yet';
      el.bulkSource.appendChild(o);
      el.bulkSource.disabled = true;
      return;
    }
    el.bulkSource.disabled = false;
    usable.forEach(function (a) {
      const o = document.createElement('option');
      o.value = String(a.id);
      o.textContent = 'Ad ' + a.slot + ' — ' + a.name + ' (#' + a.id + ')';
      el.bulkSource.appendChild(o);
    });
    if (usable.some(function (a) { return String(a.id) === prev; })) {
      el.bulkSource.value = prev;
    }
  }

  async function bulkFill(onlyEmpty) {
    const source = findAd(parseInt(el.bulkSource.value, 10));
    if (!source) { toast('Pick an ad with embed code first.', 'err'); return; }
    if (!source.embedCode.trim()) { toast('That ad has no embed code.', 'err'); return; }

    if (!onlyEmpty) {
      const ok = await confirmDialog(
        'Replace all 100 slots',
        'Every existing ad will be replaced by "' + source.name +
        '". This cannot be undone. Continue?'
      );
      if (!ok) return;
    }

    const written = fillSlotsWith(source, onlyEmpty);
    el.fillAllSlots.checked = false;
    persist();
    resetEditor(true);
    renderAll();
    renderSlots();
    toast(written + ' slot(s) now use "' + source.name + '".', 'ok');
  }

  /* ------------------------------------------------------------------
     EDITOR
     ------------------------------------------------------------------ */
  function buildSlotSelect() {
    el.adSlot.textContent = '';
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = 'Ad ' + s;
      el.adSlot.appendChild(o);
    }
  }

  /** First ad number not taken by another ad (the one being edited is free). */
  function nextFreeSlot() {
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const ad = adForSlot(s);
      if (!ad || ad.id === editingId) return s;
    }
    return 1;
  }

  function resetEditor(silent) {
    editingId = null;
    el.editorMode.textContent = 'New ad';
    el.adName.value = '';
    el.adSlot.value = String(nextFreeSlot());
    el.adCode.value = '';
    el.fillAllSlots.checked = false;
    if (!silent) setStatus('Ready. Paste your ad code, then press Save.');
  }

  function loadIntoEditor(id) {
    const ad = ads.filter(function (a) { return a.id === id; })[0];
    if (!ad) return;
    editingId = id;
    el.editorMode.textContent = 'Editing ad #' + id;
    el.adName.value = ad.name;
    el.adSlot.value = String(ad.slot || nextFreeSlot());
    el.adCode.value = ad.embedCode;
    setStatus('Loaded "' + ad.name + '" into the editor. Save to apply changes.', 'ok');
    el.adName.focus();
  }

  function findAd(id) {
    for (let i = 0; i < ads.length; i++) if (ads[i].id === id) return ads[i];
    return null;
  }

  function readEditor() {
    return {
      name: (el.adName.value || '').trim(),
      embedCode: el.adCode.value || '',
      slot: clampSlot(el.adSlot.value)
    };
  }

  async function saveAd() {
    const data = readEditor();

    if (!data.name) { setStatus('Enter an ad name first.', 'err'); el.adName.focus(); return; }
    if (ads.length >= MAX_ADS && editingId === null) {
      setStatus('Limit reached: only ' + MAX_ADS + ' ad entries are supported.', 'err');
      return;
    }
    if (!data.embedCode.trim()) {
      setStatus('Nothing to save — the embed code is empty.', 'err');
      return;
    }

    const clash = adForSlot(data.slot);
    if (clash && clash.id !== editingId) {
      const ok = await confirmDialog(
        'Ad number already used',
        'Ad number ' + data.slot + ' is already used by "' + clash.name + '". ' +
        'Saving will move "' + clash.name + '" to the next free number. Continue?'
      );
      if (!ok) return;
    }

    if (editingId === null) {
      ads.push({ id: nextId++, name: data.name, embedCode: data.embedCode, slot: data.slot });
      editingId = nextId - 1;
      setStatus('Ad "' + data.name + '" added as Ad ' + data.slot + '.', 'ok');
    } else {
      const ad = findAd(editingId);
      if (!ad) { resetEditor(); return; }
      ad.name = data.name;
      ad.embedCode = data.embedCode;
      ad.slot = data.slot;
      setStatus('Ad "' + data.name + '" updated (Ad ' + data.slot + ').', 'ok');
    }

    if (el.fillAllSlots.checked) {
      el.fillAllSlots.checked = false;
      const extra = fillSlotsWith(findAd(editingId), true);
      setStatus('Saved and copied into ' + extra + ' more slot(s).', 'ok');
    }

    persist();
    renderAll();
    renderSlots();
    toast('Configuration saved.', 'ok');
  }

  function newAd() {
    resetEditor();
    el.adName.focus();
  }

  function editCurrent() {
    if (editingId !== null) { loadIntoEditor(editingId); return; }
    setStatus('Select a row in the table and press Edit.', 'err');
  }

  async function removeAd(id) {
    const ad = findAd(id);
    if (!ad) return;
    const ok = await confirmDialog('Delete ad', 'Delete "' + ad.name + '"? This cannot be undone.');
    if (!ok) return;
    ads = ads.filter(function (a) { return a.id !== id; });
    if (editingId === id) resetEditor(true);
    persist();
    renderAll();
    renderSlots();
    toast('Ad deleted.', 'ok');
  }

  async function deleteCurrent() {
    if (editingId === null) { setStatus('No ad loaded in the editor.', 'err'); return; }
    await removeAd(editingId);
  }

  function previewCode() {
    const code = el.adCode.value || '';
    if (!code.trim()) { setStatus('Paste an embed code to preview it.', 'err'); return; }
    el.previewBox.hidden = false;
    renderEmbed(el.previewSlot, code);
    setStatus('Preview rendered from the editor (not saved).', 'ok');
  }

  /* ------------------------------------------------------------------
     IMPORT / EXPORT / CLEAR
     ------------------------------------------------------------------ */
  function exportJson() {
    const json = JSON.stringify(buildConfig(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Exported ' + FILE_NAME + ' (' + ads.length + ' ads).', 'ok');
  }

  function importJson() { el.importFile.click(); }

  function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        toast('That file is not valid JSON.', 'err');
        return;
      }
      const incoming = normalize(data);
      if (!incoming.length) {
        toast('No valid "ads" entries found in that file.', 'err');
        return;
      }
      ads = incoming;                    // imported configuration is used immediately
      syncNextId();
      persist();
      resetEditor(true);
      renderAll();
      renderSlots();
      toast('Imported ' + ads.length + ' ads from ' + file.name + '.', 'ok');
    };
    reader.onerror = function () { toast('Could not read the file.', 'err'); };
    reader.readAsText(file);
  }

  async function clearAll() {
    const ok = await confirmDialog(
      'Clear all ads',
      'This removes every ad from the app and from localStorage ("' + STORAGE_KEY + '"). Continue?'
    );
    if (!ok) return;
    ads = [];
    nextId = 1;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    resetEditor(true);
    renderAll();
    renderSlots();
    toast('All ads cleared.', 'warn');
  }

  function discardChanges() {
    const saved = localStorage.getItem(STORAGE_KEY);
    ads = saved ? normalize(JSON.parse(saved)) : normalize(DEFAULT_CONFIG);
    syncNextId();
    resetEditor(true);
    renderAll();
    renderSlots();
    toast('Reloaded the saved configuration.', 'ok');
  }

  /* ------------------------------------------------------------------
     DISPLAY PAGE — 100 ad slots
     ------------------------------------------------------------------ */
  function buildSlots() {
    el.slots.textContent = '';
    for (let n = 1; n <= TOTAL_SLOTS; n++) {
      const ad = adForSlot(n);

      const card = document.createElement('div');
      card.className = 'slot-card' + (ad ? '' : ' empty');
      card.dataset.slot = String(n);
      card.dataset.name = ad ? ad.name.toLowerCase() : '';

      const head = document.createElement('div');
      head.className = 'slot-head';

      const num = document.createElement('span');
      num.className = 'slot-num';
      num.textContent = 'Ad Slot ' + n;
      head.appendChild(num);

      const tag = document.createElement('span');
      tag.className = 'slot-tag' + (ad ? '' : ' none');
      tag.textContent = ad ? ad.name : 'empty';
      tag.title = ad ? ad.name : 'No ad configured for this slot';
      head.appendChild(tag);

      const slot = document.createElement('div');
      slot.className = 'ad-slot';
      slot.id = 'ad-slot-' + n;

      card.appendChild(head);
      card.appendChild(slot);
      el.slots.appendChild(card);
    }
  }

  function filteredSlots() {
    const mode = el.slotFilter.value;
    const q = (el.displaySearch.value || '').trim().toLowerCase();
    return Array.prototype.slice.call(el.slots.children).filter(function (card) {
      const n = parseInt(card.dataset.slot, 10);
      const has = !!adForSlot(n);
      if (mode === 'configured' && !has) return false;
      if (mode === 'empty' && has) return false;
      if (q && card.dataset.name.indexOf(q) === -1) return false;
      return true;
    });
  }

  function renderDisplay() {
    buildSlots();
    const cards = filteredSlots();
    cards.forEach(function (card) { card.hidden = false; });
    Array.prototype.forEach.call(el.slots.children, function (card) {
      if (cards.indexOf(card) === -1) card.hidden = true;
    });
    paintSlots();
  }

  function paintSlots() {
    Array.prototype.forEach.call(el.slots.children, function (card) {
      if (card.hidden) return;
      const n = parseInt(card.dataset.slot, 10);
      const ad = adForSlot(n);
      const slot = card.querySelector('.ad-slot');
      clearNode(slot);
      if (ad && ad.embedCode.trim()) {
        renderEmbed(slot, ad.embedCode);
      }
    });
  }

  function renderSlots() {
    if (el.viewDisplay.hidden) return;
    renderDisplay();
  }

  function clearDisplay() {
    Array.prototype.forEach.call(el.slots.querySelectorAll('.ad-slot'), clearNode);
    toast('All ad slots cleared (config kept).', 'warn');
  }

  /* ------------------------------------------------------------------
     NAVIGATION
     ------------------------------------------------------------------ */
  const PAGES = {
    admin:   { title: 'Manage Ads', sub: 'Add, edit and store your authorized ad embed codes.' },
    display: { title: 'Ad Display',  sub: '100 responsive ad slots rendered from the configuration.' }
  };

  function go(view) {
    el.viewAdmin.hidden = view !== 'admin';
    el.viewDisplay.hidden = view !== 'display';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    el.pageTitle.textContent = PAGES[view].title;
    el.pageSub.textContent = PAGES[view].sub;
    el.body.classList.remove('nav-open');
    try { sessionStorage.setItem('ad_manager_view', view); } catch (e) { /* ignore */ }
    if (view === 'display') renderDisplay();
    else clearDisplay();
  }

  /* ------------------------------------------------------------------
     RENDER ALL
     ------------------------------------------------------------------ */
  function renderAll() {
    renderStats();
    renderTable();
    renderBulkSource();
  }

  /* ------------------------------------------------------------------
     INIT
     ------------------------------------------------------------------ */
  function init() {
    buildSlotSelect();
    loadInitial();
    syncNextId();
    resetEditor(true);
    buildSlots();
    renderAll();

    /* nav */
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-view')); });
    });
    el.menuBtn.addEventListener('click', function () { el.body.classList.toggle('nav-open'); });
    el.scrim.addEventListener('click', function () { el.body.classList.remove('nav-open'); });

    /* table */
    el.adSearch.addEventListener('input', renderTable);
    el.sortBySlot.addEventListener('click', function () {
      sortBySlot = !sortBySlot;
      el.sortBySlot.textContent = sortBySlot ? 'Sort: name' : 'Sort: slot';
      renderTable();
    });

    /* editor */
    el.btnSave.addEventListener('click', saveAd);
    el.btnAddAd.addEventListener('click', newAd);
    el.btnEdit.addEventListener('click', editCurrent);
    el.btnDelete.addEventListener('click', deleteCurrent);
    el.btnPreview.addEventListener('click', previewCode);
    el.closePreview.addEventListener('click', function () {
      el.previewBox.hidden = true;
      clearNode(el.previewSlot);
    });

    /* data */
    el.btnSaveLocal.addEventListener('click', function () {
      if (persist()) { toast('Configuration saved to "' + STORAGE_KEY + '".', 'ok'); }
    });
    el.btnDiscard.addEventListener('click', discardChanges);
    el.btnExport.addEventListener('click', exportJson);
    el.topExport.addEventListener('click', exportJson);
    el.btnImport.addEventListener('click', importJson);
    el.importFile.addEventListener('change', function () {
      handleImportFile(this.files && this.files[0]);
      this.value = '';
    });
    el.btnClearAll.addEventListener('click', clearAll);
    el.btnFillEmpty.addEventListener('click', function () { bulkFill(true); });
    el.btnFillAll.addEventListener('click', function () { bulkFill(false); });

    /* display */
    el.btnRender.addEventListener('click', renderDisplay);
    el.topRender.addEventListener('click', function () { go('display'); renderDisplay(); });
    el.btnClearDisplay.addEventListener('click', clearDisplay);
    el.slotFilter.addEventListener('change', renderDisplay);
    el.displaySearch.addEventListener('input', renderDisplay);

    /* modal */
    el.modalOk.addEventListener('click', function () { closeModal(true); });
    el.modalCancel.addEventListener('click', function () { closeModal(false); });
    el.modal.addEventListener('click', function (e) { if (e.target === el.modal) closeModal(false); });

    /* textarea: Tab inserts two spaces, Ctrl/Cmd+S saves */
    el.adCode.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = this.selectionStart, t = this.selectionEnd;
        this.value = this.value.slice(0, s) + '  ' + this.value.slice(t);
        this.selectionStart = this.selectionEnd = s + 2;
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveAd();
      }
    });

    /* remember last view */
    let lastView = '';
    try { lastView = sessionStorage.getItem('ad_manager_view') || ''; } catch (e) { lastView = ''; }
    if (lastView === 'display') go('display');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
