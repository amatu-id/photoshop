// Menu bar, document tabs, status bar, home screen and command palette

import { App, toast } from '../state.js';
import { h, icon, $, fmtKey, fmtBytes } from '../util.js';
import { showMenu, closeMenus, isMenuOpen, dialog, ibtn } from './controls.js';
import { MENUS, resolveMenu, CMD } from '../actions.js';
import { ICONS } from '../icons.js';
import * as io from '../io.js';
import * as ops from '../ops.js';

// ── Menu bar ─────────────────────────────────────────────────────────────
export function buildMenubar() {
  const bar = $('#menubar');
  const brand = h('div.brand', h('span', { html: ICONS.logo, style: { display: 'grid' } }), h('span', { text: 'Amatu Photo' }));
  brand.firstChild.firstChild.setAttribute('width', 20); brand.firstChild.firstChild.setAttribute('height', 20);
  const menus = h('div.menus', { style: { display: 'flex', gap: '1px' } });
  let open = null;
  const openMenu = (btn, items) => {
    menus.querySelectorAll('.open').forEach(b => b.classList.remove('open'));
    btn.classList.add('open'); open = btn;
    const r = btn.getBoundingClientRect();
    showMenu(() => resolveMenu(items), r.left, r.bottom + 4);
  };
  for (const [name, items] of MENUS) {
    const b = h('button.mitem', { type: 'button', text: name });
    b.addEventListener('pointerdown', e => { e.preventDefault(); if (open === b && isMenuOpen()) { closeMenus(); return; } openMenu(b, items); });
    b.addEventListener('mouseenter', () => { if (open && open !== b && isMenuOpen()) openMenu(b, items); });
    menus.append(b);
  }
  App.on('menuclosed', () => { menus.querySelectorAll('.open').forEach(b => b.classList.remove('open')); open = null; });
  const search = h('div.search-cmd', { role: 'button', tabindex: 0 }, icon('search'), h('span', { text: 'Cari perintah, tool, filter…' }), h('kbd', { text: fmtKey('Mod+F') }));
  search.onclick = () => App.commandPalette();
  const theme = ibtn('contrast', 'Tema & efek liquid glass', e => showMenu(() => resolveMenu(MENUS.find(m => m[0] === 'Window')[1]().find(x => x.label === 'Tema').sub), e.clientX - 200, e.clientY + 14));
  const ws = ibtn('dashboard', 'Workspace', e => showMenu(() => resolveMenu(MENUS.find(m => m[0] === 'Window')[1]().find(x => x.label === 'Workspace').sub), e.clientX - 200, e.clientY + 14));
  const panelsBtn = ibtn('view_sidebar', 'Tampilkan/sembunyikan panel|Tab', () => App.toggleDock());
  const share = h('button.btn.primary.sm', { type: 'button', style: { marginLeft: '6px' } }, icon('ios_share'), 'Ekspor');
  share.onclick = () => App.doc ? CMD.exportAs.run() : toast('Buka dokumen terlebih dahulu');
  bar.append(brand, menus, h('div.spacer'), h('div.right', search, ws, theme, panelsBtn, share));
}

// ── Document tabs ────────────────────────────────────────────────────────
export function buildTabs() {
  const el = $('#doctabs');
  const render = () => {
    el.replaceChildren(...App.docs.map(d => {
      const t = h('div.dtab' + (d === App.doc ? '.on' : '') + (d.dirty ? '.dirty' : ''), { role: 'tab', title: `${d.name} @ ${Math.round(d.view.zoom * 100)}% (${d.colorMode}/8)` },
        h('span.nm', { text: `${d.name} @ ${Math.round(d.view.zoom * 100)}% (${d.active?.name || ''}, ${d.colorMode}/8)` }), h('i.dot'),
        (() => { const x = h('button.x', { type: 'button', 'aria-label': 'Tutup' }, icon('close')); x.onclick = e => { e.stopPropagation(); App.closeDoc(d); }; return x; })());
      t.onclick = () => App.setDoc(d);
      t.onauxclick = e => { if (e.button === 1) App.closeDoc(d); };
      return t;
    }));
    if (!App.docs.length) el.append(h('div.dtab.on', h('span.nm', { text: 'Beranda' })));
  };
  for (const e of ['docs', 'docchange', 'viewchange', 'layers', 'dirty', 'history']) App.on(e, render);
  render();
}

// ── Status bar ───────────────────────────────────────────────────────────
export function buildStatus() {
  const el = $('#statusbar');
  const zoom = h('input.inp.zoomin', { value: '100%' });
  zoom.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const v = parseFloat(zoom.value); if (v > 0) App.view.zoomTo(v / 100); zoom.blur(); } });
  let mode = 'dims';
  const info = h('div.info', { 'data-tip': 'Klik untuk mengganti info' });
  const pos = h('span'), prog = h('div.prog', h('i'));
  info.onclick = e => showMenu([['dims', 'Dimensi Dokumen'], ['size', 'Ukuran Dokumen'], ['profile', 'Profil Dokumen'], ['tool', 'Tool Saat Ini'], ['zoomlvl', 'Zoom']].map(([k, n]) => ({ label: n, checked: mode === k, run: () => { mode = k; render(); } })), e.clientX, e.clientY - 160);
  el.append(zoom, info, h('div.grow'), pos, prog);
  const render = () => {
    const d = App.doc;
    zoom.style.visibility = d ? 'visible' : 'hidden';
    if (!d) { info.replaceChildren(h('span', { text: 'Amatu Photo siap' })); return; }
    zoom.value = (Math.round(d.view.zoom * 10000) / 100) + '%';
    const txt = { dims: `${d.w} px × ${d.h} px (${d.ppi} ppi)`, size: `Dok: ${fmtBytes(d.w * d.h * 3)}/${fmtBytes(d.w * d.h * 4 * d.flat().length)}`, profile: `sRGB IEC61966-2.1 (${d.colorMode}/8)`, tool: App.activeTool()?.name || '', zoomlvl: `${Math.round(d.view.zoom * 100)}%` }[mode];
    info.replaceChildren(h('span', { text: txt }), icon('chevron_right'));
  };
  App.on('cursor', ev => { pos.textContent = ev && App.doc ? `X: ${Math.floor(ev.x)}  Y: ${Math.floor(ev.y)}` : ''; });
  App.on('busy', on => prog.classList.toggle('on', !!on));
  for (const e of ['viewchange', 'docchange', 'docsize', 'tool', 'layers']) App.on(e, render);
  render();
}

// ── Home screen ──────────────────────────────────────────────────────────
export function buildHome() {
  const el = $('#home');
  const render = async () => {
    const recent = await io.listRecent();
    const quick = [['Instagram Post', 1080, 1080, 72], ['Full HD', 1920, 1080, 72], ['A4 Cetak', 2480, 3508, 300], ['Story', 1080, 1920, 72], ['YouTube Thumbnail', 1280, 720, 72], ['Persegi 2000', 2000, 2000, 72]];
    el.replaceChildren(
      h('h1', { text: 'Selamat datang di Amatu Photo' }),
      h('div.sub', { text: 'Editor foto profesional berbasis layer — langsung di browser, tanpa unggah ke server.' }),
      h('div.row',
        h('button.btn.primary', { type: 'button', onclick: () => CMD.new.run() }, icon('add'), 'Buat Baru'),
        h('button.btn', { type: 'button', onclick: () => CMD.open.run() }, icon('folder_open'), 'Buka…'),
        h('button.btn', { type: 'button', onclick: () => ops.paste() }, icon('content_paste'), 'Tempel dari Clipboard'),
        h('button.btn', { type: 'button', onclick: () => App.openSample() }, icon('landscape'), 'Buka Contoh Proyek')),
      h('h2', { text: 'Mulai cepat' }),
      h('div.preset-grid', ...quick.map(([n, w, hh, ppi]) => {
        const k = 64 / Math.max(w, hh);
        const p = h('div.preset', h('div.shape', h('i', { style: { width: w * k + 'px', height: hh * k + 'px' } })), h('b', { text: n }), h('small', { text: `${w} × ${hh} px` }));
        p.onclick = () => { App.untitled++; ops.makeDocument({ name: `${n}-${App.untitled}`, w, h: hh, ppi, bg: '#ffffff' }); };
        return p;
      })),
      h('h2', { text: 'Terbaru' }),
      recent.length ? h('div.recent-grid', ...recent.map(r => {
        const del = ibtn('delete', 'Hapus dari Terbaru', async e => { e.stopPropagation(); if (await App.confirm(`Hapus "${r.name}" dari penyimpanan browser?`, { ok: 'Hapus' })) { await io.deleteRecent(r.id); render(); } }, { cls: '.del' });
        const c = h('div.recent', h('div.th', h('img', { src: r.thumb, alt: '' })), h('div.meta', h('b', { text: r.name }), h('small', { text: `${r.w} × ${r.h} px · ${new Date(r.updated).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}` })), del);
        c.onclick = () => io.openRecent(r.id); return c;
      })) : h('div.empty', { text: 'Belum ada berkas. Simpan dokumen dengan ' + fmtKey('Mod+S') + ' untuk menyimpannya di browser ini.' }),
      h('h2', { text: 'Tips', style: { marginTop: '28px' } }),
      h('div.tips', ...[
        ['drag_pan', 'Tahan Spasi untuk menggeser kanvas, Alt + gulir untuk zoom.'],
        ['layers', `${fmtKey('Mod+J')} menduplikat layer, ${fmtKey('Mod+G')} mengelompokkan, ${fmtKey('Alt+Mod+G')} membuat clipping mask.`],
        ['brush', 'Tekan [ dan ] untuk ukuran brush, Shift+[ ] untuk hardness, angka 1–0 untuk opacity.'],
        ['auto_awesome', 'Spot Healing & Remove Tool memakai Content-Aware untuk menghapus objek.'],
        ['photo_filter', `Camera Raw Filter (${fmtKey('Shift+Mod+A')}) untuk mengolah warna seperti di Lightroom.`],
        ['upload_file', 'Seret gambar atau PSD ke jendela untuk membukanya. Shift saat menjatuhkan = layer baru.'],
      ].map(([ic, t]) => h('div.tip', icon(ic), h('span', { text: t })))),
    );
  };
  App.on('recent', () => App.showingHome && render());
  App.showHome = (on) => {
    App.showingHome = on || !App.docs.length;
    el.classList.toggle('on', App.showingHome);
    if (App.showingHome) render();
  };
}

// ── Command palette (⌘F) ─────────────────────────────────────────────────
export function commandPalette() {
  const items = [];
  for (const C of Object.values(CMD)) items.push({ label: C.labelFn ? C.labelFn() : C.label, sub: C.menu || '', key: C.key, run: C.run, disabled: C.disabled });
  for (const T of Object.values(App.tools)) items.push({ label: T.name, sub: 'Tool', key: T.key, run: () => App.setTool(T.id) });
  const q = h('input.q', { placeholder: 'Cari perintah, tool, filter, adjustment…' }), res = h('div.res');
  let sel = 0, shown = [];
  const render = () => {
    const s = q.value.toLowerCase().trim();
    shown = items.filter(i => !s || (i.label + ' ' + i.sub).toLowerCase().includes(s)).filter(i => !(typeof i.disabled === 'function' ? i.disabled() : i.disabled)).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    res.replaceChildren(...shown.map((i, k) => { const r = h('div.r' + (k === sel ? '.on' : ''), h('span', { text: i.label.replace('…', '') }), h('small', { text: i.sub }), i.key ? h('kbd', { text: fmtKey(i.key) }) : null); r.onclick = () => run(i); r.onmouseenter = () => { sel = k; res.querySelectorAll('.r').forEach((x, j) => x.classList.toggle('on', j === k)); }; return r; }));
    res.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  let d;
  const run = i => { d.close(); setTimeout(() => i.run(), 10); };
  q.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    if (e.key === 'Enter' && shown[sel]) run(shown[sel]);
    if (e.key === 'Escape') d.close();
  });
  q.oninput = () => { sel = 0; render(); };
  d = dialog({ title: 'Cari', body: h('div', q, res), cls: '.cmdk', noBackdropClose: false });
  d.el.querySelector('.dlg-head').remove(); d.el.querySelector('.dlg-body').style.padding = 0;
  render(); setTimeout(() => q.focus(), 20);
}
App.commandPalette = commandPalette;
