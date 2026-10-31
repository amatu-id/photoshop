// Hand-drawn 24×24 tool & option icons (stroke = currentColor)

const S = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const F = 'fill="currentColor" stroke="none"';
const dash = 'stroke-dasharray="2.6 2.2"';

const cursorPath = 'M5 3.5v14l3.6-3.4 2.6 6 2.4-1-2.6-5.9h5z';
const nib = 'M12 3l5.5 9.5-3 6.5h-5l-3-6.5z M12 3v7.5 M10.6 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0 M9.5 19h5v2h-5z';
const brushP = 'M20.5 3.5c-2 0-7.6 5.6-9.6 8.6l1 1c3-2 8.6-7.6 8.6-9.6z M10.6 12.4c-2 .2-3.3 1.6-3.6 3.5-.2 1.5-1 2.5-2.5 3.2 3.3 1 7.2.2 7.4-3.4.1-1.4-.4-2.6-1.3-3.3z';
const eraserP = 'M8.5 20h11 M4.6 14.6l9.2-9.2a2 2 0 0 1 2.8 0l3.5 3.5a2 2 0 0 1 0 2.8L13 19.6a2 2 0 0 1-1.4.6H8.8a2 2 0 0 1-1.4-.6l-2.8-2.8a2 2 0 0 1 0-2.2z M9.4 9.8l5.8 5.8';
const stampP = 'M7 21h10 M6 17.5h12v2H6z M8 17.5v-2.2c0-1.2 1-2 2-2.3V10a3 3 0 1 1 4 0v3c1 .3 2 1.1 2 2.3v2.2';
const dropP = 'M12 3.5c3.6 4.4 5.5 7.6 5.5 10a5.5 5.5 0 0 1-11 0c0-2.4 1.9-5.6 5.5-10z';
const handP = 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11 M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5 M14 10.5V5.5a1.5 1.5 0 0 1 3 0V12 M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.8-2.4L4.3 14a1.6 1.6 0 0 1 2.5-2L8 13.5';
const eyeDrop = 'M14.5 5.5l4 4 M17.3 3.4a2 2 0 0 1 2.8 2.8l-2 2-2.8-2.8z M15.8 8.2l-9.3 9.3L4 20l2.5-.3 9.3-9.5';
const sparkle = (x, y, s = 2.2) => `M${x} ${y - s}v${s * 2} M${x - s} ${y}h${s * 2}`;
const bandage = 'M4.7 14.2l9.5-9.5a3.2 3.2 0 0 1 4.6 4.6l-9.5 9.5a3.2 3.2 0 0 1-4.6-4.6z M9 9.9l4.6 4.6';

export const ICONS = {
  move: S(`<path d="${cursorPath}"/><path d="M18 14.5v6 M15 17.5h6 M18 14.5l-1 1 M18 14.5l1 1 M21 17.5l-1-1 M21 17.5l-1 1"/>`),
  artboard: S('<path d="M7 3v4 M3 7h4 M17 3v4 M17 7h4 M7 17v4 M3 17h4 M17 17v4 M17 17h4"/><rect x="7" y="7" width="10" height="10" rx="1"/>'),
  'marquee-rect': S(`<rect x="4" y="5" width="16" height="14" rx=".5" ${dash}/>`),
  'marquee-ellipse': S(`<ellipse cx="12" cy="12" rx="8.5" ry="6.5" ${dash}/>`),
  'marquee-row': S(`<path d="M3 10.5h18 M3 13.5h18" ${dash}/>`),
  'marquee-col': S(`<path d="M10.5 3v18 M13.5 3v18" ${dash}/>`),
  lasso: S('<path d="M8 15.5C5.3 14.4 4 12.6 4 10.5 4 7 7.6 4.5 12 4.5s8 2.5 8 6-3.6 6-8 6c-1 0-2-.1-2.9-.4"/><path d="M9 15.5c-1.5.4-2.2 1.4-1.6 2.5.5 1-.2 2-1.4 2.5"/>'),
  'polygon-lasso': S(`<path d="M8.5 15.6L4 9l7-4.5L20 8l-3 8z" ${dash}/><path d="M8.5 15.6c-1.4.6-1.9 1.6-1.2 2.6.6.9 0 1.8-1.3 2.3"/>`),
  'magnetic-lasso': S('<path d="M8 15.5C5.3 14.4 4 12.6 4 10.5 4 7 7.6 4.5 12 4.5s8 2.5 8 6c0 1.4-.6 2.6-1.6 3.6"/><path d="M14 15.5v3a2 2 0 0 0 4 0v-3 M14 17h1.2 M16.8 17H18"/><path d="M8.5 15.5c-1.4.6-1.8 1.6-1.2 2.6"/>'),
  'quick-select': S(`<circle cx="9.5" cy="9.5" r="5.8" ${dash}/><path d="M19.8 13c-1.4 0-5 3.7-6.3 5.6l.8.8c1.9-1.3 5.5-4.9 5.5-6.4z M13.2 18.8c-1.2.1-2 .9-2.2 2.1"/>`),
  'magic-wand': S(`<path d="M4 20l11-11 M14 8l2 2"/><path stroke-width="1.3" d="${sparkle(17.5, 4.5)} ${sparkle(20, 11, 1.6)} ${sparkle(11, 3.5, 1.6)}"/>`),
  'object-select': S(`<rect x="3.5" y="3.5" width="13" height="11" rx="1" ${dash}/><path d="M12 11v9.5l2.6-2.4 1.8 4 1.7-.8-1.8-3.9h3.5z"/>`),
  crop: S('<path d="M6.5 2.5v15h15 M2.5 6.5h15v15"/>'),
  eyedropper: S(`<path d="${eyeDrop}"/>`),
  'color-sampler': S(`<path d="${eyeDrop}"/><circle cx="18" cy="18" r="2.6"/><path d="M18 14v1.4 M18 20.6V22 M14 18h1.4 M20.6 18H22"/>`),
  ruler: S('<path d="M3.5 16.5l13-13 4 4-13 13z M7 13l1.6 1.6 M9.5 10.5l2.4 2.4 M12 8l1.6 1.6 M14.5 5.5l2.4 2.4"/>'),
  'spot-healing': S(`<path d="${bandage}"/><path stroke-width="1.2" d="${sparkle(19, 15, 1.6)} ${sparkle(15.5, 19.5, 1.2)}"/><circle cx="12" cy="12" r=".6" ${F}/>`),
  healing: S(`<path d="${bandage}"/><circle cx="10.4" cy="12.4" r=".6" ${F}/><circle cx="12.4" cy="10.4" r=".6" ${F}/><circle cx="12.4" cy="14.4" r=".6" ${F}/><circle cx="14.4" cy="12.4" r=".6" ${F}/>`),
  'remove-tool': S(`<path d="${brushP}"/><path stroke-width="1.3" d="${sparkle(5.5, 5.5, 2.2)} ${sparkle(17, 18, 1.6)}"/>`),
  patch: S('<path d="M5 9c0-3 2.5-5 6-5h1c3.5 0 7 2 7 5.5S16 15 12.5 15H11c-2 0-3 1.2-3 2.6 0 1.6-1.3 2.4-2.6 2.4"/><path stroke-dasharray="1.6 1.8" d="M8 9.5h7"/>'),
  'red-eye': S('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M19 2.5v4 M17 4.5h4"/>'),
  brush: S(`<path d="${brushP}"/>`),
  pencil: S('<path d="M15.5 4.5l4 4L9 19l-5 1 1-5z M13.5 6.5l4 4 M5 15l4 4"/>'),
  'color-replace': S(`<path d="${brushP}"/><path d="M15 15.5a3.5 3.5 0 0 1 5.2 1.3 M20.2 21a3.5 3.5 0 0 1-5.4-1 M20.4 14.5v2.4H18 M14.6 21.5v-2.4H17"/>`),
  mixer: S(`<path d="${brushP}"/><path d="M18 14c1.3 1.6 2 2.7 2 3.7a2 2 0 0 1-4 0c0-1 .7-2.1 2-3.7z"/>`),
  clone: S(`<path d="${stampP}"/>`),
  'pattern-stamp': S(`<path d="${stampP}"/><path stroke-width="1.1" d="M3 3h4v4H3z M3 5h4 M5 3v4"/>`),
  'history-brush': S(`<path d="${brushP}"/><path d="M3.5 7.5a5 5 0 1 1 1.6 3.7 M3.2 4.6v3.2h3.2"/>`),
  'art-history': S(`<path d="${brushP}"/><path d="M3 9c0-3 3-5 5-3s-1 4-2 2 2-4 4-3"/>`),
  eraser: S(`<path d="${eraserP}"/>`),
  'bg-eraser': S(`<path d="${eraserP}"/><path stroke-width="1.3" stroke-dasharray="1.4 1.6" d="M2.5 4.5h7 M2.5 7h4.5"/>`),
  'magic-eraser': S(`<path d="${eraserP}"/><path stroke-width="1.3" d="${sparkle(5, 5, 2)} ${sparkle(9.5, 2.8, 1.3)}"/>`),
  gradient: S(`<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><rect x="5" y="6.5" width="3" height="11" ${F} opacity=".9"/><rect x="8" y="6.5" width="3" height="11" ${F} opacity=".62"/><rect x="11" y="6.5" width="3" height="11" ${F} opacity=".38"/><rect x="14" y="6.5" width="3" height="11" ${F} opacity=".18"/>`),
  bucket: S('<path d="M4.5 11.5L11 5l7 7-6.5 6.5a2 2 0 0 1-2.8 0L4.5 14.3a2 2 0 0 1 0-2.8z M4.5 12.5h13 M8 3.5l3 3"/><path d="M20 14.5c1 1.4 1.5 2.3 1.5 3a1.5 1.5 0 0 1-3 0c0-.7.5-1.6 1.5-3z"/>'),
  'blur-tool': S(`<path d="${dropP}"/>`),
  'sharpen-tool': S('<path d="M12 3l6 17H6z"/>'),
  smudge: S('<path d="M9 21v-5.5L6.2 12a1.6 1.6 0 0 1 2.4-2.1L10 11.5V3.8a1.5 1.5 0 0 1 3 0V10l4.6 1a2 2 0 0 1 1.5 2.3L18 21"/>'),
  dodge: S('<circle cx="14.5" cy="9.5" r="5"/><path d="M11 13l-7 7.5"/>'),
  burn: S('<path d="M7 20v-5.2c-1.4-1-2.2-2.5-2.2-4.2a5.5 5.5 0 0 1 9.2-4M15 6.5c2 0 3.6 1.6 3.6 3.6 0 1.4-.8 2.6-2 3.2 M11 20v-4 M15 20v-4.6 M10.2 9.6a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0"/>'),
  sponge: S('<path d="M5 8.5c0-2 1.5-3.5 3.5-3.5h7c2 0 3.5 1.5 3.5 3.5V16c0 2-1.5 3.5-3.5 3.5h-7C6.5 19.5 5 18 5 16z"/><circle cx="9" cy="10" r="1"/><circle cx="14.5" cy="9" r=".8"/><circle cx="12" cy="14" r="1.2"/><circle cx="15.5" cy="15.5" r=".7"/><circle cx="8.5" cy="15.5" r=".7"/>'),
  pen: S(`<path d="${nib}"/>`),
  'freeform-pen': S(`<path d="M14 3l4.2 7.3-2.3 5H12l-2.3-5z M14 3v5.8 M12.9 10.3a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0"/><path d="M3 20c2-3 3-1 4.5-2.5S8 13 10 15"/>`),
  'add-anchor': S(`<path d="M10 3l5 8.6-2.7 5.9H7.7L5 11.6z M10 3v6.8 M8.8 11a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0"/><path d="M19 13v6 M16 16h6"/>`),
  'delete-anchor': S(`<path d="M10 3l5 8.6-2.7 5.9H7.7L5 11.6z M10 3v6.8 M8.8 11a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0"/><path d="M16 16h6"/>`),
  'convert-point': S('<path d="M4 20L12 5l8 15"/><rect x="10.5" y="3.5" width="3" height="3" fill="currentColor"/>'),
  type: S('<path d="M5 6.5V4.5h14v2 M12 4.5v15 M9 19.5h6"/>'),
  'type-vertical': S('<path d="M4 4.5h10 M9 4.5v10 M7 14.5h4 M18 4v15 M16 17l2 2 2-2"/>'),
  'type-mask': S(`<path d="M5 6.5V4.5h14v2 M12 4.5v15 M9 19.5h6" ${dash}/>`),
  'path-select': S(`<path d="${cursorPath}" fill="currentColor"/>`),
  'direct-select': S(`<path d="${cursorPath}"/>`),
  'shape-rect': S('<rect x="4" y="5.5" width="16" height="13" rx="1"/>'),
  'shape-ellipse': S('<ellipse cx="12" cy="12" rx="8.5" ry="7"/>'),
  'shape-triangle': S('<path d="M12 4.5l8.5 15h-17z"/>'),
  'shape-polygon': S('<path d="M12 3.5l7.8 4.5v8L12 20.5 4.2 16V8z"/>'),
  'shape-line': S('<path d="M4.5 19.5l15-15"/>'),
  'shape-custom': S('<path d="M12 20s-7.5-4.5-7.5-10A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.6c0 5.5-7.5 10-7.5 10z"/>'),
  hand: S(`<path d="${handP}"/>`),
  'rotate-view': S(`<path d="${handP}" transform="translate(2 2) scale(.85)"/><path d="M3 8.5a8 8 0 0 1 6-5.3 M3 4v4.5h4.5"/>`),
  zoom: S('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  // option bar
  'sel-new': S('<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  'sel-add': S('<rect x="3.5" y="3.5" width="11" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="9.5" y="9.5" width="11" height="11" rx="1" fill="currentColor" stroke="none"/>'),
  'sel-sub': S('<rect x="3.5" y="3.5" width="11" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="9.5" y="9.5" width="11" height="11" rx="1"/>'),
  'sel-int': S('<rect x="3.5" y="3.5" width="11" height="11" rx="1"/><rect x="9.5" y="9.5" width="11" height="11" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" stroke="none"/>'),
  'pressure-o': S('<path d="M15 4l5 5-9 9-5 1 1-5z"/><circle cx="6" cy="18" r="3.5" opacity=".5"/>'),
  'pressure-s': S('<path d="M15 4l5 5-9 9-5 1 1-5z"/><path d="M3 21l4-4"/>'),
  airbrush: S('<path d="M5 15l7-7 4 4-7 7z M12 8l3-3 4 4-3 3"/><path stroke-width="1.2" d="M3 9.5h.01 M5 7h.01 M3 12h.01 M6 4.5h.01" stroke-width="2"/>'),
  'sample-cont': S(`<path d="${eyeDrop}"/><path d="M3 5h4 M3 8h2"/>`),
  'sample-once': S(`<path d="${eyeDrop}"/><path d="M4 4v4"/>`),
  'sample-bg': S(`<path d="${eyeDrop}"/><rect x="3" y="3" width="5" height="5" fill="currentColor" stroke="none"/>`),
  'grad-linear': `<svg viewBox="0 0 24 24"><defs><linearGradient id="gl"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="4" width="18" height="16" rx="2" fill="url(#gl)" stroke="currentColor" stroke-opacity=".5"/></svg>`,
  'grad-radial': `<svg viewBox="0 0 24 24"><defs><radialGradient id="gr"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs><rect x="3" y="4" width="18" height="16" rx="2" fill="url(#gr)" stroke="currentColor" stroke-opacity=".5"/></svg>`,
  'grad-angle': S('<rect x="3" y="4" width="18" height="16" rx="2" opacity=".5"/><path d="M12 12L12 4 M12 12l7 4" /><path d="M12 12L4 7" opacity=".5"/>'),
  'grad-reflected': `<svg viewBox="0 0 24 24"><defs><linearGradient id="gf"><stop offset="0" stop-color="currentColor" stop-opacity="0"/><stop offset=".5" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="4" width="18" height="16" rx="2" fill="url(#gf)" stroke="currentColor" stroke-opacity=".5"/></svg>`,
  'grad-diamond': S('<rect x="3" y="4" width="18" height="16" rx="2" opacity=".5"/><path d="M12 6l6 6-6 6-6-6z" fill="currentColor" fill-opacity=".5"/>'),
  logo: `<svg viewBox="0 0 64 64"><defs><linearGradient id="lg-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6aa8ff"/><stop offset=".55" stop-color="#7b5cff"/><stop offset="1" stop-color="#ff6fae"/></linearGradient><linearGradient id="lg-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect x="3" y="3" width="58" height="58" rx="15" fill="url(#lg-a)"/><rect x="3" y="3" width="58" height="58" rx="15" fill="url(#lg-b)"/><circle cx="32" cy="33" r="14" fill="none" stroke="#fff" stroke-width="4.2"/><path d="M32 19l7 12-7 16-7-16z" fill="#fff" opacity=".92"/><circle cx="46.5" cy="17.5" r="3.6" fill="#fff"/></svg>`,
};
export const toolIcon = name => ICONS[name] || ICONS.move;
