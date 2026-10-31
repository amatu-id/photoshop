// Command registry + menu structure + keyboard shortcuts

import { App, commit, invalidate, toast, savePrefs } from './state.js';
import * as ops from './ops.js';
import * as io from './io.js';
import * as dlg from './ui/dialogs.js';
import { liquifyDialog, selectAndMaskDialog } from './ui/bigdialogs.js';
import { ADJUSTMENTS, ADJ_ORDER, autoTone, autoColor, desaturate, equalize } from './adjust.js';
import { FILTERS, FILTER_GROUPS } from './filters.js';
import { Selection } from './selection.js';
import { ctx2d } from './util.js';
import { shapePath } from './composite.js';
import { editTarget, touchTarget } from './tools/base.js';
import { rgbCss } from './color.js';

const D = () => App.doc;
const hasDoc = () => !!App.doc;
const noDoc = () => !App.doc;
const hasSel = () => !!App.doc?.selection;
const L = () => App.doc?.active;
const isRasterish = () => !!L() && !L().isGroup;

export const CMD = {};
function c(id, label, run, o = {}) { CMD[id] = { id, label, run, ...o }; return id; }

// ── File ─────────────────────────────────────────────────────────────────
c('new', 'Baru…', () => dlg.newDocDialog(), { key: 'Mod+N' });
c('open', 'Buka…', () => io.openDialog(), { key: 'Mod+O' });
c('place', 'Place Embedded…', () => io.placeDialog(), { disabled: noDoc });
c('close', 'Tutup', () => App.closeDoc(D()), { key: 'Mod+W', disabled: noDoc });
c('closeAll', 'Tutup Semua', () => App.closeAll(), { key: 'Alt+Mod+W', disabled: noDoc });
c('save', 'Simpan', () => io.saveToBrowser(), { key: 'Mod+S', disabled: noDoc });
c('saveAs', 'Simpan Sebagai…', () => dlg.saveAsDialog(), { key: 'Shift+Mod+S', disabled: noDoc });
c('saveCopy', 'Unduh Proyek (.amp)', () => io.downloadProject(), { disabled: noDoc });
c('exportAs', 'Export As…', () => dlg.exportAsDialog(), { key: 'Alt+Shift+Mod+W', disabled: noDoc });
c('quickPng', 'Quick Export as PNG', () => io.quickExport('png'), { key: "Alt+Shift+Mod+'", disabled: noDoc });
c('exportJpg', 'Ekspor JPEG', () => io.quickExport('jpg'), { disabled: noDoc });
c('exportWebp', 'Ekspor WebP', () => io.quickExport('webp'), { disabled: noDoc });
c('exportPsd', 'Ekspor PSD…', () => io.exportPSD(), { disabled: noDoc });
c('exportLayers', 'Layers to Files (ZIP)', () => io.exportLayers(), { disabled: noDoc });
c('print', 'Cetak…', () => io.printDoc(), { key: 'Mod+P', disabled: noDoc });
c('home', 'Layar Beranda', () => App.showHome(true));

// ── Edit ─────────────────────────────────────────────────────────────────
c('undo', 'Undo', () => App.undo(), { key: 'Mod+Z', disabled: () => !D()?.history.canUndo, labelFn: () => D()?.history.canUndo ? `Undo ${D().history.states[D().history.index].label}` : 'Undo' });
c('redo', 'Redo', () => App.redo(), { key: 'Shift+Mod+Z', disabled: () => !D()?.history.canRedo, labelFn: () => D()?.history.canRedo ? `Redo ${D().history.states[D().history.index + 1].label}` : 'Redo' });
c('stepBack', 'Step Backward', () => App.undo(), { key: 'Alt+Mod+Z', disabled: () => !D()?.history.canUndo });
c('stepFwd', 'Step Forward', () => App.redo(), { key: 'Shift+Alt+Mod+Z', disabled: () => !D()?.history.canRedo });
c('cut', 'Cut', () => ops.copy(false, true), { key: 'Mod+X', disabled: noDoc });
c('copy', 'Copy', () => ops.copy(false), { key: 'Mod+C', disabled: noDoc });
c('copyMerged', 'Copy Merged', () => ops.copy(true), { key: 'Shift+Mod+C', disabled: noDoc });
c('paste', 'Paste', () => ops.paste(false), { key: 'Mod+V' });
c('pasteInPlace', 'Paste in Place', () => ops.paste(true), { key: 'Shift+Mod+V', disabled: noDoc });
c('clear', 'Clear', () => ops.clearSelection(), { key: 'Delete', disabled: () => !hasSel() });
c('fill', 'Fill…', () => dlg.fillDialog(), { key: 'Shift+F5', disabled: noDoc });
c('fillFg', 'Isi dengan Warna Depan', () => ops.fill({ use: 'fg' }), { key: 'Alt+Backspace', disabled: noDoc });
c('fillBg', 'Isi dengan Warna Latar', () => ops.fill({ use: 'bg' }), { key: 'Mod+Backspace', disabled: noDoc });
c('stroke', 'Stroke…', () => dlg.strokeDialog(), { disabled: () => !hasSel() });
c('contentAware', 'Content-Aware Fill', () => ops.fill({ use: 'content' }), { disabled: () => !hasSel() });
c('freeTransform', 'Free Transform', () => App.transform.start('free'), { key: 'Mod+T', disabled: () => !isRasterish() });
for (const [m, n] of [['scale', 'Scale'], ['rotate', 'Rotate'], ['skew', 'Skew'], ['distort', 'Distort'], ['perspective', 'Perspective']]) c('tr-' + m, n, () => App.transform.start(m), { disabled: () => !isRasterish() });
c('tr-r180', 'Rotate 180°', () => App.transform.start('free').then(() => { App.transform.rotateBy(180); App.transform.commit(); }), { disabled: () => !isRasterish() });
c('tr-r90', 'Rotate 90° Clockwise', () => App.transform.start('free').then(() => { App.transform.rotateBy(90); App.transform.commit(); }), { disabled: () => !isRasterish() });
c('tr-r90ccw', 'Rotate 90° Counter Clockwise', () => App.transform.start('free').then(() => { App.transform.rotateBy(-90); App.transform.commit(); }), { disabled: () => !isRasterish() });
c('tr-fliph', 'Flip Horizontal', () => ops.flipLayer('h'), { disabled: () => !isRasterish() });
c('tr-flipv', 'Flip Vertical', () => ops.flipLayer('v'), { disabled: () => !isRasterish() });
c('defineBrush', 'Define Brush Preset…', () => ops.defineBrush(), { disabled: noDoc });
c('definePattern', 'Define Pattern…', () => ops.definePattern(), { disabled: noDoc });
c('prefs', 'Preferensi…', () => dlg.prefsDialog(), { key: 'Mod+K' });
c('shortcuts', 'Pintasan Keyboard…', () => dlg.shortcutsDialog(Object.values(CMD).map(x => ({ ...x, menu: x.menu }))), { key: 'Alt+Shift+Mod+K' });
c('search', 'Cari Perintah…', () => App.commandPalette(), { key: 'Mod+F' });

// ── Image ────────────────────────────────────────────────────────────────
for (const group of ADJ_ORDER) for (const k of group) c('adj-' + k, ADJUSTMENTS[k].name + (k === 'invert' ? '' : '…'), () => k === 'invert' ? ops.invertMaskOrLayer() : dlg.adjustDialog(k), { disabled: noDoc, key: { levels: 'Mod+L', curves: 'Mod+M', 'hue-saturation': 'Mod+U', 'color-balance': 'Mod+B', 'black-white': 'Alt+Shift+Mod+B', invert: 'Mod+I' }[k] });
c('adj-shadows', 'Shadows/Highlights…', () => dlg.shadowsHighlightsDialog(), { disabled: noDoc });
c('adj-replace', 'Replace Color…', () => dlg.replaceColorDialog(), { disabled: noDoc });
c('adj-desat', 'Desaturate', () => ops.applyPixels('Desaturate', img => desaturate(img)), { key: 'Shift+Mod+U', disabled: noDoc });
c('adj-equalize', 'Equalize', () => ops.applyPixels('Equalize', img => equalize(img)), { disabled: noDoc });
c('autoTone', 'Auto Tone', () => ops.applyPixels('Auto Tone', img => autoTone(img, true)), { key: 'Shift+Mod+L', disabled: noDoc });
c('autoContrast', 'Auto Contrast', () => ops.applyPixels('Auto Contrast', img => autoTone(img, false)), { key: 'Alt+Shift+Mod+L', disabled: noDoc });
c('autoColor', 'Auto Color', () => ops.applyPixels('Auto Color', img => autoColor(img)), { key: 'Shift+Mod+B', disabled: noDoc });
c('imageSize', 'Image Size…', () => dlg.imageSizeDialog(), { key: 'Alt+Mod+I', disabled: noDoc });
c('canvasSize', 'Canvas Size…', () => dlg.canvasSizeDialog(), { key: 'Alt+Mod+C', disabled: noDoc });
c('rot180', '180°', () => ops.rotateCanvas(180), { disabled: noDoc });
c('rot90', '90° Clockwise', () => ops.rotateCanvas(90), { disabled: noDoc });
c('rot90ccw', '90° Counter Clockwise', () => ops.rotateCanvas(-90), { disabled: noDoc });
c('rotArb', 'Arbitrary…', () => dlg.rotateArbitraryDialog(), { disabled: noDoc });
c('flipCanvasH', 'Flip Canvas Horizontal', () => ops.flipCanvas('h'), { disabled: noDoc });
c('flipCanvasV', 'Flip Canvas Vertical', () => ops.flipCanvas('v'), { disabled: noDoc });
c('cropSel', 'Crop', () => ops.cropToSelection(), { disabled: () => !hasSel() });
c('trim', 'Trim (transparan)', () => ops.trim('transparent'), { disabled: noDoc });
c('trimColor', 'Trim (warna piksel kiri atas)', () => ops.trim('topleft'), { disabled: noDoc });
c('revealAll', 'Reveal All', () => ops.revealAll(), { disabled: noDoc });
c('duplicateDoc', 'Duplikat…', () => dlg.duplicateDocDialog(), { disabled: noDoc });
c('modeGray', 'Grayscale', async () => { if (!await App.confirm('Ubah ke Grayscale? Semua layer piksel akan dihilangkan warnanya.')) return; for (const x of D().flat()) if (x.type === 'raster') { const cx = ctx2d(x.canvas), im = cx.getImageData(0, 0, x.w, x.h); desaturate(im); cx.putImageData(im, 0, 0); x.touch(); } D().colorMode = 'Grayscale'; invalidate(); commit('Grayscale', 'filter_b_and_w'); }, { disabled: noDoc, checked: () => D()?.colorMode === 'Grayscale' });
c('modeRGB', 'RGB Color', () => { D().colorMode = 'RGB'; App.emit('docsize'); }, { disabled: noDoc, checked: () => D()?.colorMode !== 'Grayscale' });

// ── Layer ────────────────────────────────────────────────────────────────
c('newLayer', 'Layer…', () => dlg.newLayerDialog(), { key: 'Shift+Mod+N', disabled: noDoc });
c('newLayerQuick', 'Layer Baru', () => ops.newLayer(), { key: 'Alt+Shift+Mod+N', disabled: noDoc });
c('newGroup', 'Group', () => ops.newGroup(), { disabled: noDoc });
c('layerViaCopy', 'Layer via Copy', () => ops.layerViaCopy(false), { key: 'Mod+J', disabled: noDoc });
c('layerViaCut', 'Layer via Cut', () => ops.layerViaCopy(true), { key: 'Shift+Mod+J', disabled: noDoc });
c('dupLayer', 'Duplikat Layer', () => ops.duplicateLayers(), { disabled: noDoc });
c('delLayer', 'Hapus Layer', () => ops.deleteLayers(), { disabled: noDoc });
c('layerFromBg', 'Layer from Background', () => { ops.convertBackground(L()); commit('Layer dari Background', 'layers'); }, { disabled: () => !L()?.isBackground });
c('layerStyle', 'Blending Options…', () => dlg.layerStyleDialog('blending'), { disabled: noDoc });
for (const [k, n] of [['dropShadow', 'Drop Shadow…'], ['innerShadow', 'Inner Shadow…'], ['outerGlow', 'Outer Glow…'], ['innerGlow', 'Inner Glow…'], ['bevel', 'Bevel & Emboss…'], ['satin', 'Satin…'], ['colorOverlay', 'Color Overlay…'], ['gradientOverlay', 'Gradient Overlay…'], ['stroke', 'Stroke…']]) c('ls-' + k, n, () => dlg.layerStyleDialog(k), { disabled: noDoc });
c('copyStyle', 'Copy Layer Style', () => { App.styleClip = L()?.styles ? structuredClone(L().styles) : null; toast('Layer style disalin'); }, { disabled: () => !L()?.styles });
c('pasteStyle', 'Paste Layer Style', () => { for (const x of D().selectedLayers()) { x.styles = structuredClone(App.styleClip); x._styled = null; x.touch(); } invalidate(); App.emit('layers'); commit('Paste Layer Style', 'auto_awesome'); }, { disabled: () => !App.styleClip || noDoc() });
c('clearStyle', 'Clear Layer Style', () => { for (const x of D().selectedLayers()) { x.styles = null; x._styled = null; x.touch(); } invalidate(); App.emit('layers'); commit('Clear Layer Style', 'auto_awesome'); }, { disabled: () => !L()?.styles });
c('fillSolid', 'Solid Color…', () => ops.newFillLayer('solid'), { disabled: noDoc });
c('fillGradient', 'Gradient…', () => ops.newFillLayer('gradient', { stops: [[0, '#000000', 1], [1, '#ffffff', 1]] }), { disabled: noDoc });
c('fillPattern', 'Pattern…', () => App.patterns.length ? ops.newFillLayer('pattern') : toast('Belum ada pola. Gunakan Edit › Define Pattern.'), { disabled: noDoc });
for (const group of ADJ_ORDER) for (const k of group) c('al-' + k, ADJUSTMENTS[k].name + '…', () => ops.newAdjustmentLayer(k), { disabled: noDoc });
c('maskReveal', 'Reveal All', () => ops.addMask('reveal'), { disabled: () => !L() || !!L().mask });
c('maskHide', 'Hide All', () => ops.addMask('hideAll'), { disabled: () => !L() || !!L().mask });
c('maskRevealSel', 'Reveal Selection', () => ops.addMask('reveal'), { disabled: () => !hasSel() || !!L()?.mask });
c('maskHideSel', 'Hide Selection', () => ops.addMask('hide'), { disabled: () => !hasSel() || !!L()?.mask });
c('maskDelete', 'Delete', () => ops.deleteMask(false), { disabled: () => !L()?.mask });
c('maskApply', 'Apply', () => ops.deleteMask(true), { disabled: () => !L()?.mask || L().type !== 'raster' });
c('maskToggle', 'Disable / Enable', () => ops.toggleMask(), { disabled: () => !L()?.mask });
c('removeBg', 'Hapus Latar Belakang', () => ops.removeBackground(), { disabled: noDoc });
c('clip', 'Create Clipping Mask', () => ops.toggleClip(), { key: 'Alt+Mod+G', disabled: noDoc, labelFn: () => L()?.clip ? 'Release Clipping Mask' : 'Create Clipping Mask' });
c('group', 'Group Layers', () => ops.groupLayers(), { key: 'Mod+G', disabled: noDoc });
c('ungroup', 'Ungroup Layers', () => ops.ungroup(), { key: 'Shift+Mod+G', disabled: () => !L()?.isGroup });
c('hideLayers', 'Hide Layers', () => { for (const x of D().selectedLayers()) x.visible = !x.visible; invalidate(); App.emit('layers'); commit('Visibilitas Layer', 'visibility'); }, { key: 'Mod+,', disabled: noDoc });
c('front', 'Bring to Front', () => ops.arrange('front'), { key: 'Shift+Mod+]', disabled: noDoc });
c('forward', 'Bring Forward', () => ops.arrange('forward'), { key: 'Mod+]', disabled: noDoc });
c('backward', 'Send Backward', () => ops.arrange('backward'), { key: 'Mod+[', disabled: noDoc });
c('back', 'Send to Back', () => ops.arrange('back'), { key: 'Shift+Mod+[', disabled: noDoc });
c('reverse', 'Reverse', () => ops.reverseLayers(), { disabled: () => (D()?.selectedLayers().length || 0) < 2 });
for (const [k, n] of [['top', 'Top Edges'], ['vcenter', 'Vertical Centers'], ['bottom', 'Bottom Edges'], ['left', 'Left Edges'], ['hcenter', 'Horizontal Centers'], ['right', 'Right Edges']]) c('align-' + k, n, () => ops.align(k), { disabled: noDoc });
c('dist-h', 'Distribute Horizontal Centers', () => ops.align('dist-h'), { disabled: noDoc });
c('dist-v', 'Distribute Vertical Centers', () => ops.align('dist-v'), { disabled: noDoc });
c('lockAll', 'Lock Layers…', () => { for (const x of D().selectedLayers()) x.locks.all = !x.locks.all; App.emit('layers'); commit('Kunci Layer', 'lock'); }, { key: 'Mod+/', disabled: noDoc });
c('rasterize', 'Rasterize Layer', () => { ops.rasterize(L()); commit('Rasterize', 'texture'); }, { disabled: () => !L() || L().type === 'raster' || L().isGroup || L().type === 'adjust' });
c('rasterizeStyle', 'Rasterize Layer Style', () => { const x = L(); const c2 = ops.layerToDoc(x); x.type = 'raster'; x.canvas = c2; x.x = 0; x.y = 0; x.styles = null; x.mask = null; x.text = null; x.shape = null; x.fill = null; x._cache = null; x.touch(); invalidate(); App.emit('layers'); commit('Rasterize Layer Style', 'texture'); }, { disabled: () => !L()?.styles });
c('mergeDown', 'Merge Down', () => ops.mergeDown(), { key: 'Mod+E', disabled: noDoc, labelFn: () => (D()?.selectedLayers().length > 1 ? 'Merge Layers' : 'Merge Down') });
c('mergeVisible', 'Merge Visible', () => ops.mergeVisible(), { key: 'Shift+Mod+E', disabled: noDoc });
c('stampVisible', 'Stamp Visible', () => ops.stampVisible(), { key: 'Alt+Shift+Mod+E', disabled: noDoc });
c('flatten', 'Flatten Image', () => ops.flatten(), { disabled: noDoc });
c('selectUp', 'Pilih Layer di Atas', () => App.selectAdjacentLayer(1), { key: 'Alt+]', disabled: noDoc });
c('selectDown', 'Pilih Layer di Bawah', () => App.selectAdjacentLayer(-1), { key: 'Alt+[', disabled: noDoc });

// ── Type ─────────────────────────────────────────────────────────────────
c('warpText', 'Warp Text…', () => dlg.warpTextDialog(), { disabled: () => L()?.type !== 'text' });
c('rasterizeType', 'Rasterize Type Layer', () => { ops.rasterize(L()); commit('Rasterize Type', 'texture'); }, { disabled: () => L()?.type !== 'text' });
c('textToShape', 'Convert to Shape', () => { ops.rasterize(L()); toast('Teks dikonversi ke piksel (vektor glyph tidak tersedia di browser)'); commit('Convert to Shape', 'category'); }, { disabled: () => L()?.type !== 'text' });
c('loadFonts', 'Muat Font Lokal…', () => App.loadLocalFonts());
c('panelChar', 'Panel Character', () => App.emit('showpanel', 'character'));

// ── Select ───────────────────────────────────────────────────────────────
c('selAll', 'All', () => ops.selectAll(), { key: 'Mod+A', disabled: noDoc });
c('deselect', 'Deselect', () => ops.deselect(), { key: 'Mod+D', disabled: () => !hasSel() });
c('reselect', 'Reselect', () => ops.reselect(), { key: 'Shift+Mod+D', disabled: () => App.lastSel?.docId !== D()?.id });
c('inverse', 'Inverse', () => ops.inverse(), { key: 'Shift+Mod+I', disabled: noDoc });
c('allLayers', 'All Layers', () => { const d = D(); d.selectedIds = new Set(d.flat().filter(x => !x.isBackground).map(x => x.id)); App.emit('layers'); }, { key: 'Alt+Mod+A', disabled: noDoc });
c('deselectLayers', 'Deselect Layers', () => { const d = D(); d.selectedIds = new Set(); App.emit('layers'); }, { disabled: noDoc });
c('colorRange', 'Color Range…', () => dlg.colorRangeDialog(), { disabled: noDoc });
c('subject', 'Subject', () => ops.selectSubject(), { disabled: noDoc });
c('sky', 'Sky', () => { const d = D(); const img = ctx2d(d._comp).getImageData(0, 0, d.w, d.h); const m = ops.colorRangeMask(img, { preset: 'blues' }); const s = Selection.fromAlpha(d.w, d.h, m); s.smooth(3); ops.setSel(s, 'Select Sky'); }, { disabled: noDoc });
c('selectMask', 'Select and Mask…', () => selectAndMaskDialog(), { key: 'Alt+Mod+R', disabled: noDoc });
for (const k of ['border', 'smooth', 'expand', 'contract']) c('mod-' + k, k[0].toUpperCase() + k.slice(1) + '…', () => dlg.modifyDialog(k), { disabled: () => !hasSel() });
c('mod-feather', 'Feather…', () => dlg.modifyDialog('feather'), { key: 'Shift+F6', disabled: () => !hasSel() });
c('grow', 'Grow', () => ops.grow(false), { disabled: () => !hasSel() });
c('similar', 'Similar', () => ops.grow(true), { disabled: () => !hasSel() });
c('loadSel', 'Load Selection (transparansi layer)', () => ops.loadLayerSelection(L()), { disabled: noDoc });
c('saveSel', 'Save Selection…', async () => { const n = await App.prompt('Nama channel:', `Alpha ${D().channels.length + 1}`); if (n !== null) ops.saveSelectionChannel(n); }, { disabled: () => !hasSel() });
c('quickMask', 'Edit in Quick Mask Mode', () => App.toggleQuickMask(), { key: 'Q', disabled: noDoc, checked: () => App.quickMask });

// ── Filter ───────────────────────────────────────────────────────────────
c('lastFilter', 'Last Filter', () => App.lastFilter && ops.runFilter(App.lastFilter.id, App.lastFilter.params), { key: 'Alt+Mod+F', disabled: () => !App.lastFilter || noDoc(), labelFn: () => App.lastFilter ? FILTERS[App.lastFilter.id].name.replace('…', '') : 'Last Filter' });
c('cameraRaw', 'Camera Raw Filter…', () => dlg.cameraRawDialog(), { key: 'Shift+Mod+A', disabled: noDoc });
c('liquify', 'Liquify…', () => liquifyDialog(), { key: 'Shift+Mod+X', disabled: noDoc });
for (const [id, F] of Object.entries(FILTERS)) c('f-' + id, F.name, () => dlg.filterDialog(id), { disabled: noDoc });

// ── View ─────────────────────────────────────────────────────────────────
c('zoomIn', 'Zoom In', () => App.view.zoomStep(1), { key: 'Mod+=', disabled: noDoc });
c('zoomOut', 'Zoom Out', () => App.view.zoomStep(-1), { key: 'Mod+-', disabled: noDoc });
c('fit', 'Fit on Screen', () => App.view.fit(), { key: 'Mod+0', disabled: noDoc });
c('actual', '100%', () => App.view.actual(), { key: 'Mod+1', disabled: noDoc });
c('z200', '200%', () => App.view.zoomTo(2), { key: 'Mod+2', disabled: noDoc });
c('fillScreen', 'Fill Screen', () => App.view.fit(true), { disabled: noDoc });
const pref = (k, label, key) => c('pref-' + k, label, () => { App.prefs[k] = !App.prefs[k]; savePrefs(); App.applyPrefs(); }, { key, checked: () => !!App.prefs[k] });
pref('extras', 'Extras', 'Mod+H'); pref('rulers', 'Rulers', 'Mod+R'); pref('grid', 'Grid', "Mod+'"); pref('guides', 'Guides', 'Mod+;'); pref('pixelGrid', 'Pixel Grid'); pref('snap', 'Snap', 'Shift+Mod+;');
c('lockGuides', 'Lock Guides', () => { D().guidesLocked = !D().guidesLocked; }, { key: 'Alt+Mod+;', disabled: noDoc, checked: () => !!D()?.guidesLocked });
c('clearGuides', 'Clear Guides', () => { D().guides = []; App.view.redraw(); commit('Hapus Guides', 'border_clear'); }, { disabled: () => !D()?.guides.length });
c('newGuide', 'New Guide…', async () => { const v = await App.prompt('Posisi guide (px). Awali dengan "h" untuk horizontal, mis. h200:', 'v100'); if (!v) return; const o = v.trim()[0] === 'h' ? 'h' : 'v'; const p = parseFloat(v.replace(/^[hv]/i, '')); if (!isNaN(p)) { D().guides.push({ o, p }); App.view.redraw(); commit('Guide Baru', 'border_vertical'); } }, { disabled: noDoc });
c('guideLayout', 'New Guide Layout (3 × 3)', () => { const d = D(); for (let i = 1; i < 3; i++) { d.guides.push({ o: 'v', p: Math.round(d.w * i / 3) }, { o: 'h', p: Math.round(d.h * i / 3) }); } App.view.redraw(); commit('Guide Layout', 'grid_on'); }, { disabled: noDoc });
c('screenMode', 'Ganti Screen Mode', () => App.cycleScreenMode(), { key: 'F' });
c('toggleUI', 'Sembunyikan Panel', () => App.toggleDock(), { key: 'Tab' });

// ── Window / Help ────────────────────────────────────────────────────────
const PANELS = [['layers', 'Layers', 'F7'], ['channels', 'Channels'], ['paths', 'Paths'], ['properties', 'Properties'], ['adjustments', 'Adjustments'], ['color', 'Color', 'F6'], ['swatches', 'Swatches'], ['gradients', 'Gradients'], ['history', 'History'], ['navigator', 'Navigator'], ['info', 'Info', 'F8'], ['histogram', 'Histogram'], ['brushes', 'Brushes', 'F5'], ['character', 'Character'], ['paragraph', 'Paragraph']];
for (const [id, n, key] of PANELS) c('panel-' + id, n, () => App.emit('showpanel', id), { key });
for (const [id, n] of [['essentials', 'Essentials (Default)'], ['photography', 'Photography'], ['painting', 'Painting'], ['graphic', 'Graphic & Web']]) c('ws-' + id, n, () => App.setWorkspace(id), { checked: () => App.prefs.workspace === id || (!App.prefs.workspace && id === 'essentials') });
for (const [id, n] of dlg.THEMES) c('theme-' + id, n, () => { App.prefs.theme = id; savePrefs(); App.applyPrefs(); }, { checked: () => App.prefs.theme === id });
c('glassToggle', 'Efek Liquid Glass', () => { App.prefs.glass = !App.prefs.glass; savePrefs(); App.applyPrefs(); }, { checked: () => App.prefs.glass });
c('about', 'Tentang Amatu Photo', () => dlg.aboutDialog());
c('tips', 'Tips & Panduan Cepat', () => App.showHome(true));

// Path panel helpers
c('pathToSelection', 'Make Selection', () => App.pathOp('selection'));
c('pathToMask', 'Vector Mask', () => App.pathOp('mask'));
c('pathToShape', 'Shape Layer', () => App.pathOp('shape'));
c('fillPath', 'Fill Path', () => App.pathOp('fill'));
c('strokePath', 'Stroke Path', () => App.pathOp('stroke'));
App.pathOp = async (op) => {
  const d = D(); if (!d) return;
  const L0 = d.active;
  const ep = L0?.type === 'shape' && App.pathTarget !== 'doc' ? { subpaths: L0.shape.subpaths, ox: L0.x, oy: L0.y } : (() => { const P = d.paths.find(p => p.id === d.activePathId); return P ? { subpaths: P.subpaths, ox: 0, oy: 0 } : null; })();
  if (!ep || !ep.subpaths.length) { toast('Tidak ada path aktif'); return; }
  const p = shapePath({ subpaths: ep.subpaths }), M = new DOMMatrix().translate(ep.ox, ep.oy), P2 = new Path2D(); P2.addPath(p, M);
  if (op === 'selection') return ops.setSel(Selection.path(d.w, d.h, P2, { feather: 0 }), 'Make Selection');
  if (op === 'mask') { d.selection = Selection.path(d.w, d.h, P2); return ops.addMask('reveal'); }
  if (op === 'shape') { const { newShapeLayer, rebuildShape } = await import('./tools/vector.js'); const Ls = newShapeLayer({ kind: 'path' }); Ls.shape.params = null; Ls.shape.subpaths = structuredClone(ep.subpaths).map(sp => ({ ...sp, pts: sp.pts.map(q => { const o = { ...q }; for (const k of ['x', 'ix', 'ox']) if (o[k] !== undefined) o[k] += ep.ox; for (const k of ['y', 'iy', 'oy']) if (o[k] !== undefined) o[k] += ep.oy; return o; }) })); rebuildShape(Ls); invalidate(); commit('Shape dari Path', 'category'); return; }
  const t = await editTarget(); if (!t) return;
  const x = ctx2d(t.canvas); x.save(); x.translate(-t.x, -t.y);
  if (op === 'fill') { x.fillStyle = rgbCss(App.fg); x.fill(P2); }
  else { const o = App.toolOpts.brush || {}; x.strokeStyle = rgbCss(App.fg); x.lineWidth = Math.max(1, (o.size || 6) / 3); x.lineCap = 'round'; x.lineJoin = 'round'; x.stroke(P2); }
  x.restore(); touchTarget(t); invalidate(); commit(op === 'fill' ? 'Fill Path' : 'Stroke Path', 'draw');
};

// ── Menu tree ────────────────────────────────────────────────────────────
const I = id => ({ cmd: id });
const sub = (label, items) => ({ label, sub: items });
export const MENUS = [
  ['File', [I('new'), I('open'), I('home'), '-', I('close'), I('closeAll'), '-', I('save'), I('saveAs'), I('saveCopy'), '-', I('place'), '-', sub('Export', [I('quickPng'), I('exportAs'), '-', I('exportJpg'), I('exportWebp'), I('exportPsd'), '-', I('exportLayers')]), '-', I('print')]],
  ['Edit', [I('undo'), I('redo'), I('stepFwd'), I('stepBack'), '-', I('cut'), I('copy'), I('copyMerged'), I('paste'), I('pasteInPlace'), I('clear'), '-', I('search'), '-', I('fill'), I('stroke'), I('contentAware'), '-', I('freeTransform'), sub('Transform', [I('tr-scale'), I('tr-rotate'), I('tr-skew'), I('tr-distort'), I('tr-perspective'), '-', I('tr-r180'), I('tr-r90'), I('tr-r90ccw'), '-', I('tr-fliph'), I('tr-flipv')]), '-', I('defineBrush'), I('definePattern'), '-', I('shortcuts'), I('prefs')]],
  ['Image', [sub('Mode', [I('modeGray'), I('modeRGB')]), '-', sub('Adjustments', [...ADJ_ORDER[0].map(k => I('adj-' + k)), '-', ...ADJ_ORDER[1].map(k => I('adj-' + k)), '-', ...ADJ_ORDER[2].map(k => I('adj-' + k)), '-', I('adj-shadows'), I('adj-desat'), I('adj-replace'), I('adj-equalize')]), '-', I('autoTone'), I('autoContrast'), I('autoColor'), '-', I('imageSize'), I('canvasSize'), sub('Image Rotation', [I('rot180'), I('rot90'), I('rot90ccw'), I('rotArb'), '-', I('flipCanvasH'), I('flipCanvasV')]), I('cropSel'), I('trim'), I('trimColor'), I('revealAll'), '-', I('duplicateDoc')]],
  ['Layer', [sub('New', [I('newLayer'), I('newGroup'), I('layerFromBg'), '-', I('layerViaCopy'), I('layerViaCut')]), I('dupLayer'), I('delLayer'), '-', sub('Layer Style', [I('layerStyle'), '-', I('ls-bevel'), I('ls-stroke'), I('ls-innerShadow'), I('ls-innerGlow'), I('ls-satin'), I('ls-colorOverlay'), I('ls-gradientOverlay'), I('ls-outerGlow'), I('ls-dropShadow'), '-', I('copyStyle'), I('pasteStyle'), I('clearStyle')]), '-', sub('New Fill Layer', [I('fillSolid'), I('fillGradient'), I('fillPattern')]), sub('New Adjustment Layer', [...ADJ_ORDER[0].map(k => I('al-' + k)), '-', ...ADJ_ORDER[1].map(k => I('al-' + k)), '-', ...ADJ_ORDER[2].map(k => I('al-' + k))]), '-', sub('Layer Mask', [I('maskReveal'), I('maskHide'), I('maskRevealSel'), I('maskHideSel'), '-', I('maskDelete'), I('maskApply'), '-', I('maskToggle')]), I('clip'), I('removeBg'), '-', I('group'), I('ungroup'), I('hideLayers'), '-', sub('Arrange', [I('front'), I('forward'), I('backward'), I('back'), '-', I('reverse')]), sub('Align', [I('align-top'), I('align-vcenter'), I('align-bottom'), '-', I('align-left'), I('align-hcenter'), I('align-right')]), sub('Distribute', [I('dist-h'), I('dist-v')]), '-', I('lockAll'), '-', sub('Rasterize', [I('rasterize'), I('rasterizeStyle')]), '-', I('mergeDown'), I('mergeVisible'), I('stampVisible'), I('flatten')]],
  ['Type', [I('panelChar'), I('loadFonts'), '-', I('warpText'), '-', I('rasterizeType'), I('textToShape')]],
  ['Select', [I('selAll'), I('deselect'), I('reselect'), I('inverse'), '-', I('allLayers'), I('deselectLayers'), '-', I('colorRange'), I('subject'), I('sky'), '-', I('selectMask'), sub('Modify', [I('mod-border'), I('mod-smooth'), I('mod-expand'), I('mod-contract'), I('mod-feather')]), '-', I('grow'), I('similar'), '-', I('quickMask'), '-', I('loadSel'), I('saveSel')]],
  ['Filter', () => [I('lastFilter'), '-', I('cameraRaw'), I('liquify'), '-', ...FILTER_GROUPS.map(g => sub(g, Object.entries(FILTERS).filter(([, F]) => F.group === g).map(([id]) => I('f-' + id))))]],
  ['View', [I('zoomIn'), I('zoomOut'), I('fit'), I('actual'), I('z200'), I('fillScreen'), '-', I('screenMode'), '-', I('pref-extras'), sub('Show', [I('pref-grid'), I('pref-guides'), I('pref-pixelGrid')]), I('pref-rulers'), I('pref-snap'), '-', I('lockGuides'), I('clearGuides'), I('newGuide'), I('guideLayout')]],
  ['Window', () => [sub('Workspace', [I('ws-essentials'), I('ws-photography'), I('ws-painting'), I('ws-graphic')]), sub('Tema', [...dlg.THEMES.map(([id]) => I('theme-' + id)), '-', I('glassToggle')]), '-', ...PANELS.map(([id]) => I('panel-' + id)), '-', I('toggleUI')]],
  ['Help', [I('tips'), I('shortcuts'), '-', I('about')]],
];
export function resolveMenu(items) {
  const list = typeof items === 'function' ? items() : items;
  return list.map(it => {
    if (it === '-') return '-';
    if (it.sub) return { label: it.label, sub: () => resolveMenu(it.sub) };
    const C = CMD[it.cmd]; if (!C) return null;
    return { label: C.labelFn ? C.labelFn() : C.label, key: C.key, run: C.run, disabled: C.disabled, checked: C.checked };
  }).filter(Boolean);
}
// tag each command with its menu path (for search & shortcut list)
for (const [menu, items] of MENUS) {
  const walk = (list, path) => (typeof list === 'function' ? list() : list).forEach(it => { if (it === '-') return; if (it.sub) walk(it.sub, `${path} › ${it.label}`); else if (CMD[it.cmd]) CMD[it.cmd].menu ||= path; });
  walk(items, menu);
}
export const keymap = () => { const m = {}; for (const C of Object.values(CMD)) if (C.key) m[C.key] = C; return m; };
