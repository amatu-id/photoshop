// Global application state shared by every module

import { Emitter, storeGet, storeSet } from './util.js';

export const App = new Emitter();

Object.assign(App, {
  docs: [],
  doc: null,
  view: null,
  tool: null,
  toolId: 'move',
  toolOpts: storeGet('toolOpts', {}),
  fg: { r: 0, g: 0, b: 0 },
  bg: { r: 255, g: 255, b: 255 },
  quickMask: false,
  screenMode: 0,          // 0 standard, 1 full with menus, 2 full
  prefs: Object.assign({
    theme: 'glass-dark', glass: true, units: 'px', rulers: true, grid: false, guides: true, snap: true,
    extras: true, gridSize: 64, gridSub: 4, pixelGrid: true, gridColor: '#7aa7ff', guideColor: '#22d3ee',
    checker: 'medium', brushCursor: 'normal', zoomWheel: false, animatedZoom: true, historyStates: 50,
    showTips: true, uiScale: 100, recent: [],
  }, storeGet('prefs', {})),
  swatches: storeGet('swatches', null),
  lastFilter: null,
  clipboard: null,        // {canvas, x, y}
  patterns: [],
  brushes: [],
});

export function savePrefs() { storeSet('prefs', App.prefs); }
export function saveToolOpts() { storeSet('toolOpts', App.toolOpts); }

// Convenience shortcuts used across modules
export const D = () => App.doc;
export function invalidate(rect) { App.view?.invalidate(rect); }
export function redraw() { App.view?.redraw(); }
export function commit(label, icon) {
  const d = App.doc; if (!d) return;
  d.history.push(label, icon);
  App.emit('committed', label);
}
export function toast(msg, kind = 'info', ms = 2600) { App.emit('toast', msg, kind, ms); }
