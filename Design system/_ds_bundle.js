/* @ds-bundle: {"format":3,"namespace":"PowerDesignSystem_138199","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"StatusDot","sourcePath":"components/core/StatusDot.jsx"},{"name":"EnergyFlow","sourcePath":"components/data/EnergyFlow.jsx"},{"name":"ProgressBar","sourcePath":"components/data/ProgressBar.jsx"},{"name":"RadialGauge","sourcePath":"components/data/RadialGauge.jsx"},{"name":"Sparkline","sourcePath":"components/data/Sparkline.jsx"},{"name":"StatTile","sourcePath":"components/data/StatTile.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"SegmentedControl","sourcePath":"components/forms/SegmentedControl.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Slider","sourcePath":"components/forms/Slider.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"e8cf125d6f9d","components/core/Button.jsx":"87099e5475b0","components/core/Card.jsx":"1ea537e02c51","components/core/IconButton.jsx":"0361787f6d89","components/core/StatusDot.jsx":"c5422ec7ea60","components/data/EnergyFlow.jsx":"767b8c3618fd","components/data/ProgressBar.jsx":"576978913580","components/data/RadialGauge.jsx":"17fd9f43481e","components/data/Sparkline.jsx":"344d4da73b38","components/data/StatTile.jsx":"aff4609b3135","components/forms/Input.jsx":"ac5abd55d2ed","components/forms/SegmentedControl.jsx":"8be2967f4691","components/forms/Select.jsx":"a153dcc6ee8b","components/forms/Slider.jsx":"6f41150c6467","components/forms/Switch.jsx":"49641c2954b4","ui_kits/desktop/App.jsx":"fd003f8f4f33","ui_kits/desktop/Chrome.jsx":"0e5e4a3beee4","ui_kits/desktop/DevicesScreen.jsx":"e348716ae264","ui_kits/desktop/OptimizationScreen.jsx":"a74916e81880","ui_kits/desktop/OverviewScreen.jsx":"e449286b5491","ui_kits/desktop/StatisticsScreen.jsx":"0468b07e06b2","ui_kits/desktop/charts.jsx":"1cd08b7dee66","ui_kits/desktop/data.js":"8639efbffc9a","ui_kits/mobile/MobileApp.jsx":"cced7510f8fe"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PowerDesignSystem_138199 = window.PowerDesignSystem_138199 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-badge{
  display:inline-flex; align-items:center; gap:5px;
  height:22px; padding:0 9px; border-radius:var(--radius-pill);
  font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-semibold);
  letter-spacing:0.02em; line-height:1; white-space:nowrap;
  border:1px solid transparent;
}
.pwr-badge svg{ width:12px; height:12px; }
.pwr-badge--solid{ color:var(--text-inverse); }
.pwr-badge--soft{ background:var(--surface-3); color:var(--text-1); border-color:var(--border-1); }

.pwr-badge[data-tone="solar"].pwr-badge--soft{ background:var(--solar-wash); color:var(--solar); }
.pwr-badge[data-tone="battery"].pwr-badge--soft{ background:var(--battery-wash); color:var(--battery); }
.pwr-badge[data-tone="grid"].pwr-badge--soft{ background:var(--grid-wash); color:var(--grid); }
.pwr-badge[data-tone="home"].pwr-badge--soft{ background:var(--home-wash); color:var(--home); }
.pwr-badge[data-tone="danger"].pwr-badge--soft{ background:var(--danger-wash); color:var(--danger); }
.pwr-badge[data-tone="neutral"].pwr-badge--soft{ background:var(--surface-3); color:var(--text-2); }

.pwr-badge[data-tone="solar"].pwr-badge--solid{ background:var(--solar); }
.pwr-badge[data-tone="battery"].pwr-badge--solid{ background:var(--battery); }
.pwr-badge[data-tone="grid"].pwr-badge--solid{ background:var(--grid); }
.pwr-badge[data-tone="home"].pwr-badge--solid{ background:var(--home); }
.pwr-badge[data-tone="danger"].pwr-badge--solid{ background:var(--danger); color:#fff; }
.pwr-badge[data-tone="neutral"].pwr-badge--solid{ background:var(--surface-4); color:var(--text-1); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'badge');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Badge / Tag — compact status or category pill. Soft (washed) by default;
 * solid for high-emphasis live states.
 */
function Badge({
  tone = 'neutral',
  variant = 'soft',
  icon,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = ['pwr-badge', `pwr-badge--${variant}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls,
    "data-tone": tone
  }, rest), icon && icon, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-btn{
  --_h: var(--control-md);
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  height:var(--_h); padding:0 16px;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-semibold);
  letter-spacing:var(--ls-heading); line-height:1; white-space:nowrap;
  border-radius:var(--radius-md); border:1px solid transparent;
  cursor:pointer; user-select:none; text-decoration:none;
  transition:background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
             color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out),
             box-shadow var(--dur-fast) var(--ease-out);
}
.pwr-btn:active{ transform:translateY(1px) scale(0.99); }
.pwr-btn:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-btn[disabled],.pwr-btn[aria-disabled="true"]{ cursor:not-allowed; opacity:0.45; transform:none; box-shadow:none; }
.pwr-btn--sm{ --_h:var(--control-sm); padding:0 12px; font-size:var(--fs-xs); }
.pwr-btn--lg{ --_h:var(--control-lg); padding:0 22px; font-size:var(--fs-body); }
.pwr-btn--block{ display:flex; width:100%; }

.pwr-btn--primary{ background:var(--accent); color:var(--accent-contrast); box-shadow:var(--glow-soft); }
.pwr-btn--primary:hover{ background:#48f0b1; box-shadow:var(--glow-solar); }

.pwr-btn--secondary{ background:var(--surface-2); color:var(--text-1); border-color:var(--border-2); }
.pwr-btn--secondary:hover{ background:var(--surface-3); border-color:var(--border-3); }

.pwr-btn--ghost{ background:transparent; color:var(--text-2); }
.pwr-btn--ghost:hover{ background:var(--surface-2); color:var(--text-1); }

.pwr-btn--danger{ background:var(--danger); color:#fff; }
.pwr-btn--danger:hover{ background:#ff7575; }

.pwr-btn__spin{ width:14px;height:14px;border-radius:50%;
  border:2px solid currentColor;border-right-color:transparent;animation:pwr-btn-spin .7s linear infinite; }
@keyframes pwr-btn-spin{ to{ transform:rotate(360deg); } }
.pwr-btn__ic{ display:inline-flex; }
.pwr-btn__ic svg{ width:1em;height:1em; }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'button');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Button — primary action control. Solar-green fill is reserved for the single
 * most important action on a surface; everything else is secondary/ghost.
 */
function Button({
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  loading = false,
  block = false,
  disabled = false,
  as = 'button',
  className = '',
  children,
  ...rest
}) {
  inject();
  const Tag = as;
  const cls = ['pwr-btn', `pwr-btn--${variant}`, size !== 'md' && `pwr-btn--${size}`, block && 'pwr-btn--block', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement(Tag, _extends({
    className: cls,
    disabled: Tag === 'button' ? disabled || loading : undefined,
    "aria-disabled": disabled || loading || undefined
  }, rest), loading && /*#__PURE__*/React.createElement("span", {
    className: "pwr-btn__spin",
    "aria-hidden": "true"
  }), !loading && iconLeft && /*#__PURE__*/React.createElement("span", {
    className: "pwr-btn__ic"
  }, iconLeft), children, !loading && iconRight && /*#__PURE__*/React.createElement("span", {
    className: "pwr-btn__ic"
  }, iconRight));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-card{
  position:relative; display:flex; flex-direction:column;
  background:var(--surface-card); border:1px solid var(--border-1);
  border-radius:var(--radius-card); box-shadow:var(--shadow-2), var(--hairline-top);
  overflow:hidden;
}
.pwr-card--pad{ padding:var(--space-5); }
.pwr-card--interactive{ cursor:pointer; transition:border-color var(--dur) var(--ease-out),
  transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out); }
.pwr-card--interactive:hover{ border-color:var(--border-3); transform:translateY(-2px);
  box-shadow:var(--shadow-card), var(--hairline-top); }
.pwr-card--glow{ box-shadow:var(--shadow-2), var(--glow-soft), var(--hairline-top);
  border-color:rgba(46,230,160,0.28); }
/* accent rail along the top edge, tinted to the energy node */
.pwr-card[data-accent]::before{
  content:""; position:absolute; inset:0 0 auto 0; height:2px;
  background:var(--_rail, var(--accent)); opacity:0.9;
}
.pwr-card[data-accent="solar"]{ --_rail:var(--solar); }
.pwr-card[data-accent="battery"]{ --_rail:var(--battery); }
.pwr-card[data-accent="grid"]{ --_rail:var(--grid); }
.pwr-card[data-accent="home"]{ --_rail:var(--home); }
.pwr-card[data-accent="ev"]{ --_rail:var(--ev); }

.pwr-card__head{ display:flex; align-items:center; gap:var(--space-3);
  padding:var(--space-4) var(--space-5); border-bottom:1px solid var(--border-1); }
.pwr-card__title{ font-size:var(--fs-h4); font-weight:var(--fw-semibold);
  letter-spacing:var(--ls-heading); color:var(--text-1); margin:0; }
.pwr-card__sub{ font-size:var(--fs-xs); color:var(--text-2); margin:2px 0 0; }
.pwr-card__head-actions{ margin-left:auto; display:flex; align-items:center; gap:var(--space-1); }
.pwr-card__head-ic{ display:inline-flex; color:var(--text-2); }
.pwr-card__head-ic svg{ width:18px; height:18px; }
.pwr-card__body{ padding:var(--space-5); flex:1; }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'card');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Card — the canonical dark panel. A flat surface with a hairline border and
 * deep soft shadow; glow and the top accent rail are opt-in for live data.
 */
function Card({
  title,
  subtitle,
  icon,
  actions,
  accent,
  glow = false,
  interactive = false,
  padded,
  className = '',
  children,
  ...rest
}) {
  inject();
  const hasHeader = title || actions || icon;
  const cls = ['pwr-card', glow && 'pwr-card--glow', interactive && 'pwr-card--interactive', (padded ?? !hasHeader) && 'pwr-card--pad', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    "data-accent": accent || undefined
  }, rest), hasHeader && /*#__PURE__*/React.createElement("div", {
    className: "pwr-card__head"
  }, icon && /*#__PURE__*/React.createElement("span", {
    className: "pwr-card__head-ic"
  }, icon), (title || subtitle) && /*#__PURE__*/React.createElement("div", null, title && /*#__PURE__*/React.createElement("p", {
    className: "pwr-card__title"
  }, title), subtitle && /*#__PURE__*/React.createElement("p", {
    className: "pwr-card__sub"
  }, subtitle)), actions && /*#__PURE__*/React.createElement("div", {
    className: "pwr-card__head-actions"
  }, actions)), hasHeader ? /*#__PURE__*/React.createElement("div", {
    className: "pwr-card__body"
  }, children) : children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-iconbtn{
  --_s: var(--control-md);
  display:inline-flex; align-items:center; justify-content:center;
  width:var(--_s); height:var(--_s); padding:0;
  border-radius:var(--radius-md); border:1px solid transparent;
  background:transparent; color:var(--text-2); cursor:pointer;
  transition:background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
             border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.pwr-iconbtn:hover{ background:var(--surface-2); color:var(--text-1); }
.pwr-iconbtn:active{ transform:scale(0.92); }
.pwr-iconbtn:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-iconbtn[disabled]{ opacity:0.4; cursor:not-allowed; }
.pwr-iconbtn svg{ width:18px; height:18px; }
.pwr-iconbtn--sm{ --_s:var(--control-sm); }
.pwr-iconbtn--sm svg{ width:15px; height:15px; }
.pwr-iconbtn--lg{ --_s:var(--control-lg); }
.pwr-iconbtn--lg svg{ width:20px; height:20px; }
.pwr-iconbtn--solid{ background:var(--surface-2); border-color:var(--border-2); }
.pwr-iconbtn--solid:hover{ background:var(--surface-3); border-color:var(--border-3); }
.pwr-iconbtn--accent{ background:var(--accent); color:var(--accent-contrast); box-shadow:var(--glow-soft); }
.pwr-iconbtn--accent:hover{ background:#48f0b1; box-shadow:var(--glow-solar); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'iconbtn');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * IconButton — square control wrapping a single icon. Used for toolbar actions,
 * card overflow menus, and compact controls. Always pass an aria-label.
 */
function IconButton({
  variant = 'ghost',
  size = 'md',
  label,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = ['pwr-iconbtn', variant !== 'ghost' && `pwr-iconbtn--${variant}`, size !== 'md' && `pwr-iconbtn--${size}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls,
    "aria-label": label,
    title: label
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusDot.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-status{ display:inline-flex; align-items:center; gap:7px;
  font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-medium);
  color:var(--text-2); white-space:nowrap; }
.pwr-status__dot{ position:relative; width:8px; height:8px; border-radius:50%;
  background:var(--_c, var(--text-3)); flex:none; }
.pwr-status[data-tone="solar"]{ --_c:var(--solar); }
.pwr-status[data-tone="battery"]{ --_c:var(--battery); }
.pwr-status[data-tone="grid"]{ --_c:var(--grid); }
.pwr-status[data-tone="home"]{ --_c:var(--home); }
.pwr-status[data-tone="danger"]{ --_c:var(--danger); }
.pwr-status[data-tone="offline"]{ --_c:var(--text-3); }
/* pulsing halo for live states */
.pwr-status--live .pwr-status__dot::after{
  content:""; position:absolute; inset:-3px; border-radius:50%;
  background:var(--_c); opacity:0.5; animation:pwr-pulse 1.8s var(--ease-out) infinite;
}
@keyframes pwr-pulse{ 0%{ transform:scale(0.7); opacity:0.55; } 70%{ transform:scale(2.4); opacity:0; } 100%{ opacity:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-status--live .pwr-status__dot::after{ animation:none; } }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'status');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * StatusDot — a small colored dot with optional label and live pulse, for
 * connection / activity states ("Producing", "Charging", "Offline").
 */
function StatusDot({
  tone = 'offline',
  live = false,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = ['pwr-status', live && 'pwr-status--live', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls,
    "data-tone": tone
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "pwr-status__dot",
    "aria-hidden": "true"
  }), children);
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/data/EnergyFlow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-flow{ position:relative; width:100%; aspect-ratio:1.18/1; min-height:240px;
  font-family:var(--font-sans); }
.pwr-flow__svg{ position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.pwr-flow__base{ stroke:var(--border-2); stroke-width:1.4; fill:none; }
.pwr-flow__line{ fill:none; stroke-width:2.2; stroke-linecap:round;
  stroke-dasharray:5 6; animation:pwr-flow-move 0.9s linear infinite; }
@keyframes pwr-flow-move{ from{ stroke-dashoffset:11; } to{ stroke-dashoffset:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-flow__line{ animation:none; } }

.pwr-flow__node{ position:absolute; transform:translate(-50%,-50%);
  display:flex; flex-direction:column; align-items:center; gap:5px; width:84px; }
.pwr-flow__chip{ display:flex; align-items:center; justify-content:center;
  width:52px; height:52px; border-radius:16px; background:var(--surface-2);
  border:1px solid var(--border-2); color:var(--_c, var(--text-2));
  box-shadow:var(--shadow-1), var(--hairline-top); transition:box-shadow var(--dur) var(--ease-out); }
.pwr-flow__chip svg{ width:22px; height:22px; }
.pwr-flow__node--active .pwr-flow__chip{ border-color:var(--_c);
  box-shadow:0 0 0 1px var(--_c), 0 0 18px color-mix(in srgb, var(--_c) 45%, transparent); }
.pwr-flow__name{ font-size:10px; font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
.pwr-flow__kw{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:13px;
  font-weight:var(--fw-medium); color:var(--_c, var(--text-1)); line-height:1; }
.pwr-flow__kw small{ font-size:9px; color:var(--text-3); }

.pwr-flow__hub{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:58px; height:58px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background:radial-gradient(circle at 50% 35%, var(--surface-3), var(--surface-1));
  border:1px solid var(--border-3); color:var(--accent); box-shadow:var(--glow-soft); }
.pwr-flow__hub svg{ width:24px; height:24px; }
.pwr-flow__hub::after{ content:""; position:absolute; inset:-6px; border-radius:50%;
  border:1px solid rgba(46,230,160,0.25); animation:pwr-hub-ring 2.6s var(--ease-out) infinite; }
@keyframes pwr-hub-ring{ 0%{ transform:scale(0.85); opacity:0.7; } 70%{ transform:scale(1.5); opacity:0; } 100%{ opacity:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-flow__hub::after{ animation:none; } }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'flow');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const HUB = {
  x: 50,
  y: 50
};
const POS = {
  solar: {
    x: 50,
    y: 11
  },
  battery: {
    x: 12,
    y: 50
  },
  grid: {
    x: 88,
    y: 50
  },
  home: {
    x: 50,
    y: 89
  }
};
const COLOR = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)'
};
const ICON = {
  solar: 'sun',
  battery: 'battery-charging',
  grid: 'utility-pole',
  home: 'house'
};
const Ico = ({
  name
}) => /*#__PURE__*/React.createElement("i", {
  "data-lucide": name
});
function fmt(kw) {
  if (kw == null) return '0';
  const v = Math.abs(kw);
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/**
 * EnergyFlow — the signature live diagram. A central hub links Solar, Battery,
 * Grid and Home; power animates along each line in its real direction. Pass per-
 * node { kw, dir } where dir decides which way the flow travels (and if it's live).
 */
function EnergyFlow({
  solar = {
    kw: 0
  },
  battery = {
    kw: 0,
    dir: 'idle'
  },
  grid = {
    kw: 0,
    dir: 'idle'
  },
  home = {
    kw: 0
  },
  className = '',
  ...rest
}) {
  inject();

  // For each node: is it active, and which way does flow travel along the
  // hub<->node segment. We draw the animated line from source to destination.
  const links = [];
  const data = {
    solar,
    battery,
    grid,
    home
  };

  // solar always flows INTO the hub when producing
  if ((solar.kw || 0) > 0.05) links.push(seg('solar', POS.solar, HUB));
  // home always draws FROM the hub when consuming
  if ((home.kw || 0) > 0.05) links.push(seg('home', HUB, POS.home));
  // battery: charging = hub->battery, discharging = battery->hub
  if (battery.dir === 'charging' && (battery.kw || 0) > 0.05) links.push(seg('battery', HUB, POS.battery));
  if (battery.dir === 'discharging' && (battery.kw || 0) > 0.05) links.push(seg('battery', POS.battery, HUB));
  // grid: importing = grid->hub, exporting = hub->grid
  if (grid.dir === 'importing' && (grid.kw || 0) > 0.05) links.push(seg('grid', POS.grid, HUB));
  if (grid.dir === 'exporting' && (grid.kw || 0) > 0.05) links.push(seg('grid', HUB, POS.grid));
  function seg(key, from, to) {
    return {
      key,
      d: `M${from.x} ${from.y} L${to.x} ${to.y}`,
      color: COLOR[key]
    };
  }
  const activeKeys = new Set(links.map(l => l.key));
  const subLabel = {
    solar: 'Producing',
    home: 'Home load',
    battery: battery.dir === 'charging' ? 'Charging' : battery.dir === 'discharging' ? 'Discharging' : 'Idle',
    grid: grid.dir === 'importing' ? 'Importing' : grid.dir === 'exporting' ? 'Exporting' : 'Idle'
  };
  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['pwr-flow', className].filter(Boolean).join(' ')
  }, rest), /*#__PURE__*/React.createElement("svg", {
    className: "pwr-flow__svg",
    viewBox: "0 0 100 100",
    preserveAspectRatio: "none"
  }, Object.keys(POS).map(k => /*#__PURE__*/React.createElement("line", {
    key: k,
    className: "pwr-flow__base",
    x1: HUB.x,
    y1: HUB.y,
    x2: POS[k].x,
    y2: POS[k].y
  })), links.map(l => /*#__PURE__*/React.createElement("path", {
    key: l.key,
    className: "pwr-flow__line",
    d: l.d,
    style: {
      stroke: l.color
    }
  }))), Object.keys(POS).map(k => {
    const active = activeKeys.has(k);
    return /*#__PURE__*/React.createElement("div", {
      key: k,
      className: `pwr-flow__node${active ? ' pwr-flow__node--active' : ''}`,
      style: {
        left: POS[k].x + '%',
        top: POS[k].y + '%',
        '--_c': COLOR[k]
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pwr-flow__chip"
    }, /*#__PURE__*/React.createElement(Ico, {
      name: ICON[k]
    })), /*#__PURE__*/React.createElement("span", {
      className: "pwr-flow__name"
    }, k), /*#__PURE__*/React.createElement("span", {
      className: "pwr-flow__kw"
    }, fmt(data[k].kw), /*#__PURE__*/React.createElement("small", null, " kW")));
  }), /*#__PURE__*/React.createElement("div", {
    className: "pwr-flow__hub",
    title: "Home hub"
  }, /*#__PURE__*/React.createElement(Ico, {
    name: "zap"
  })));
}
Object.assign(__ds_scope, { EnergyFlow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/EnergyFlow.jsx", error: String((e && e.message) || e) }); }

// components/data/ProgressBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONE = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)',
  danger: 'var(--danger)'
};
const CSS = `
.pwr-bar{ display:flex; flex-direction:column; gap:6px; width:100%; }
.pwr-bar__top{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.pwr-bar__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-bar__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-bar__track{ position:relative; width:100%; background:var(--surface-4);
  border-radius:var(--radius-pill); overflow:hidden; }
.pwr-bar__fill{ height:100%; border-radius:var(--radius-pill); background:var(--_c, var(--accent));
  transition:width var(--dur-slow) var(--ease-out); }
.pwr-bar--glow .pwr-bar__fill{ box-shadow:0 0 12px var(--_c, var(--accent)); }
/* multi-segment (stacked) bar */
.pwr-bar__seg{ height:100%; }
.pwr-bar__seg:first-child{ border-radius:var(--radius-pill) 0 0 var(--radius-pill); }
.pwr-bar__seg:last-child{ border-radius:0 var(--radius-pill) var(--radius-pill) 0; }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'bar');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * ProgressBar — linear level/progress indicator. Single value, or a `segments`
 * array for a stacked energy-mix bar (e.g. solar vs battery vs grid share).
 */
function ProgressBar({
  value = 0,
  max = 100,
  tone = 'accent',
  height = 8,
  label,
  valueText,
  showValue = false,
  glow = false,
  segments,
  className = '',
  ...rest
}) {
  inject();
  const cls = ['pwr-bar', glow && 'pwr-bar--glow', className].filter(Boolean).join(' ');
  const pct = Math.max(0, Math.min(100, value / max * 100));
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    style: {
      '--_c': TONE[tone] || TONE.accent
    }
  }, rest), (label || showValue) && /*#__PURE__*/React.createElement("div", {
    className: "pwr-bar__top"
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "pwr-bar__label"
  }, label), showValue && /*#__PURE__*/React.createElement("span", {
    className: "pwr-bar__val"
  }, valueText != null ? valueText : `${Math.round(pct)}%`)), /*#__PURE__*/React.createElement("div", {
    className: "pwr-bar__track",
    style: {
      height
    }
  }, segments ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100%',
      width: '100%'
    }
  }, segments.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "pwr-bar__seg",
    style: {
      width: `${s.value}%`,
      background: TONE[s.tone] || s.tone || 'var(--accent)'
    },
    title: s.label
  }))) : /*#__PURE__*/React.createElement("div", {
    className: "pwr-bar__fill",
    style: {
      width: `${pct}%`
    }
  })));
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/data/RadialGauge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONE = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)'
};
const CSS = `
.pwr-gauge{ display:inline-grid; place-items:center; position:relative; }
.pwr-gauge svg{ display:block; transform:rotate(135deg); }
.pwr-gauge__arc{ transition:stroke-dashoffset var(--dur-slow) var(--ease-out); }
.pwr-gauge__center{ position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center; gap:2px; }
.pwr-gauge__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-weight:var(--fw-medium); color:var(--text-1); line-height:1; }
.pwr-gauge__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); }
.pwr-gauge__cap{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'gauge');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * RadialGauge — a 270° arc gauge for bounded values (battery %, charge level,
 * self-sufficiency). The arc fills with the energy tone over the track.
 */
function RadialGauge({
  value = 0,
  min = 0,
  max = 100,
  size = 132,
  thickness = 10,
  tone = 'battery',
  label,
  unit = '%',
  showValue = true,
  valueText,
  className = '',
  ...rest
}) {
  inject();
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270 degrees
  const track = c * sweep;
  const dash = track * pct;
  const color = TONE[tone] || TONE.battery;
  const fs = Math.round(size * 0.26);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['pwr-gauge', className].filter(Boolean).join(' '),
    style: {
      width: size,
      height: size
    }
  }, rest), /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`
  }, /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: "var(--surface-4)",
    strokeWidth: thickness,
    strokeLinecap: "round",
    strokeDasharray: `${track} ${c}`
  }), /*#__PURE__*/React.createElement("circle", {
    className: "pwr-gauge__arc",
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: color,
    strokeWidth: thickness,
    strokeLinecap: "round",
    strokeDasharray: `${dash} ${c}`,
    style: {
      filter: `drop-shadow(0 0 6px ${color})`
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "pwr-gauge__center"
  }, showValue && /*#__PURE__*/React.createElement("div", {
    className: "pwr-gauge__val",
    style: {
      fontSize: fs
    }
  }, valueText != null ? valueText : Math.round(value), unit && /*#__PURE__*/React.createElement("span", {
    className: "pwr-gauge__unit"
  }, unit)), label && /*#__PURE__*/React.createElement("div", {
    className: "pwr-gauge__cap"
  }, label)));
}
Object.assign(__ds_scope, { RadialGauge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/RadialGauge.jsx", error: String((e && e.message) || e) }); }

// components/data/Sparkline.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONE = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)'
};
let uid = 0;

/**
 * Sparkline — a compact trend line/area chart with no axes, for embedding in
 * StatTiles and table rows. Pure SVG; pass an array of numbers.
 */
function Sparkline({
  data = [],
  width = 120,
  height = 36,
  tone = 'solar',
  area = true,
  strokeWidth = 2,
  showDot = false,
  className = '',
  ...rest
}) {
  const id = React.useMemo(() => 'pwr-spark-' + uid++, []);
  if (!data.length) return /*#__PURE__*/React.createElement("svg", _extends({
    width: width,
    height: height,
    className: className
  }, rest));
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth;
  const stepX = (width - pad * 2) / (data.length - 1 || 1);
  const pts = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (d - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const fill = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
  const color = TONE[tone] || TONE.solar;
  const last = pts[pts.length - 1];
  return /*#__PURE__*/React.createElement("svg", _extends({
    width: width,
    height: height,
    viewBox: `0 0 ${width} ${height}`,
    className: className,
    preserveAspectRatio: "none"
  }, rest), /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: id,
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: color,
    stopOpacity: "0.32"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: color,
    stopOpacity: "0"
  }))), area && /*#__PURE__*/React.createElement("path", {
    d: fill,
    fill: `url(#${id})`
  }), /*#__PURE__*/React.createElement("path", {
    d: line,
    fill: "none",
    stroke: color,
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    vectorEffect: "non-scaling-stroke"
  }), showDot && /*#__PURE__*/React.createElement("circle", {
    cx: last[0],
    cy: last[1],
    r: strokeWidth + 1,
    fill: color
  }));
}
Object.assign(__ds_scope, { Sparkline });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Sparkline.jsx", error: String((e && e.message) || e) }); }

// components/data/StatTile.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-stat{ display:flex; flex-direction:column; gap:10px; min-width:0; }
.pwr-stat__top{ display:flex; align-items:center; gap:8px; }
.pwr-stat__icon{ display:inline-flex; width:26px; height:26px; align-items:center; justify-content:center;
  border-radius:var(--radius-sm); color:var(--_tone, var(--text-2)); background:var(--_wash, var(--surface-3)); }
.pwr-stat__icon svg{ width:15px; height:15px; }
.pwr-stat__label{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
.pwr-stat__value{ display:flex; align-items:baseline; gap:6px;
  font-family:var(--font-mono); font-variant-numeric:tabular-nums; letter-spacing:var(--ls-mono);
  font-weight:var(--fw-medium); color:var(--_tone, var(--text-1)); line-height:1; }
.pwr-stat__num{ font-size:var(--fs-metric-lg); }
.pwr-stat--sm .pwr-stat__num{ font-size:var(--fs-metric-md); }
.pwr-stat--xl .pwr-stat__num{ font-size:var(--fs-metric-xl); }
.pwr-stat__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); font-weight:var(--fw-regular); }
.pwr-stat__foot{ display:flex; align-items:center; gap:6px; font-size:var(--fs-xs); color:var(--text-2); }
.pwr-stat__delta{ display:inline-flex; align-items:center; gap:3px; font-family:var(--font-mono);
  font-variant-numeric:tabular-nums; font-weight:var(--fw-medium); }
.pwr-stat__delta svg{ width:12px; height:12px; }
.pwr-stat__delta--up{ color:var(--success); }
.pwr-stat__delta--down{ color:var(--danger); }
.pwr-stat__delta--flat{ color:var(--text-3); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'stat');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const TONE = {
  solar: ['var(--solar)', 'var(--solar-wash)'],
  battery: ['var(--battery)', 'var(--battery-wash)'],
  grid: ['var(--grid)', 'var(--grid-wash)'],
  home: ['var(--home)', 'var(--home-wash)'],
  ev: ['var(--ev)', 'rgba(139,140,255,0.12)'],
  neutral: [null, null]
};
const Arrow = ({
  dir
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.4",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, dir === 'up' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
  x1: "7",
  y1: "17",
  x2: "17",
  y2: "7"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "9 7 17 7 17 15"
})), dir === 'down' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
  x1: "7",
  y1: "7",
  x2: "17",
  y2: "17"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "17 9 17 17 9 17"
})), dir === 'flat' && /*#__PURE__*/React.createElement("line", {
  x1: "6",
  y1: "12",
  x2: "18",
  y2: "12"
}));

/**
 * StatTile — the core readout: a big mono value with unit, an uppercase label,
 * an optional energy-tone icon, and a delta vs a comparison period.
 */
function StatTile({
  label,
  value,
  unit,
  tone = 'neutral',
  icon,
  size = 'md',
  delta,
  deltaDir,
  footnote,
  children,
  className = '',
  ...rest
}) {
  inject();
  const [c, wash] = TONE[tone] || TONE.neutral;
  const dir = deltaDir || (typeof delta === 'number' ? delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' : 'flat');
  const style = {
    '--_tone': tone === 'neutral' ? undefined : c,
    '--_wash': wash
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['pwr-stat', size !== 'md' && `pwr-stat--${size}`, className].filter(Boolean).join(' '),
    style: style
  }, rest), (label || icon) && /*#__PURE__*/React.createElement("div", {
    className: "pwr-stat__top"
  }, icon && /*#__PURE__*/React.createElement("span", {
    className: "pwr-stat__icon"
  }, icon), label && /*#__PURE__*/React.createElement("span", {
    className: "pwr-stat__label"
  }, label)), /*#__PURE__*/React.createElement("div", {
    className: "pwr-stat__value"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pwr-stat__num"
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    className: "pwr-stat__unit"
  }, unit)), (delta != null || footnote) && /*#__PURE__*/React.createElement("div", {
    className: "pwr-stat__foot"
  }, delta != null && /*#__PURE__*/React.createElement("span", {
    className: `pwr-stat__delta pwr-stat__delta--${dir}`
  }, /*#__PURE__*/React.createElement(Arrow, {
    dir: dir
  }), typeof delta === 'number' ? `${Math.abs(delta)}%` : delta), footnote && /*#__PURE__*/React.createElement("span", null, footnote)), children);
}
Object.assign(__ds_scope, { StatTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatTile.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-input-wrap{ position:relative; display:flex; align-items:center; }
.pwr-input{ width:100%; height:var(--control-md); padding:0 12px;
  background:var(--surface-2); color:var(--text-1);
  border:1px solid var(--border-2); border-radius:var(--radius-md);
  font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out),
             background var(--dur-fast) var(--ease-out); }
.pwr-input::placeholder{ color:var(--text-3); }
.pwr-input:hover{ border-color:var(--border-3); }
.pwr-input:focus{ outline:none; border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(46,230,160,0.18); background:var(--surface-1); }
.pwr-input:disabled{ opacity:0.5; cursor:not-allowed; }
.pwr-input--mono{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
.pwr-input--has-icon{ padding-left:38px; }
.pwr-input--has-suffix{ padding-right:44px; }
.pwr-input--err{ border-color:var(--danger); }
.pwr-input--err:focus{ box-shadow:0 0 0 3px var(--danger-wash); }
.pwr-input__icon{ position:absolute; left:12px; display:inline-flex; color:var(--text-3); pointer-events:none; }
.pwr-input__icon svg{ width:16px; height:16px; }
.pwr-input__suffix{ position:absolute; right:12px; font-family:var(--font-mono);
  font-size:var(--fs-xs); color:var(--text-3); pointer-events:none; }
.pwr-field__hint{ font-size:var(--fs-xs); color:var(--text-3); }
.pwr-field__hint--err{ color:var(--danger); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'input');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Input — single-line text/number field. Use `mono` for numeric config values.
 */
function Input({
  label,
  icon,
  suffix,
  hint,
  error,
  mono = false,
  id,
  className = '',
  ...rest
}) {
  inject();
  const fid = id || (label ? 'pwr-' + Math.random().toString(36).slice(2, 8) : undefined);
  const cls = ['pwr-input', mono && 'pwr-input--mono', icon && 'pwr-input--has-icon', suffix && 'pwr-input--has-suffix', error && 'pwr-input--err', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", {
    className: "pwr-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "pwr-field__label",
    htmlFor: fid
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "pwr-input-wrap"
  }, icon && /*#__PURE__*/React.createElement("span", {
    className: "pwr-input__icon"
  }, icon), /*#__PURE__*/React.createElement("input", _extends({
    id: fid,
    className: cls,
    "aria-invalid": !!error
  }, rest)), suffix && /*#__PURE__*/React.createElement("span", {
    className: "pwr-input__suffix"
  }, suffix)), (hint || error) && /*#__PURE__*/React.createElement("span", {
    className: ['pwr-field__hint', error && 'pwr-field__hint--err'].filter(Boolean).join(' ')
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/SegmentedControl.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-seg{ display:inline-flex; padding:3px; gap:2px; background:var(--surface-2);
  border:1px solid var(--border-1); border-radius:var(--radius-md); }
.pwr-seg--block{ display:flex; width:100%; }
.pwr-seg__opt{ flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 14px; border:none; background:transparent; cursor:pointer;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-medium);
  color:var(--text-2); border-radius:var(--radius-sm); white-space:nowrap;
  transition:color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
.pwr-seg__opt:hover{ color:var(--text-1); }
.pwr-seg__opt[aria-selected="true"]{ background:var(--surface-4); color:var(--text-1);
  box-shadow:var(--shadow-1), var(--hairline-top); }
.pwr-seg__opt:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-seg__opt svg{ width:15px; height:15px; }
.pwr-seg--sm .pwr-seg__opt{ height:26px; padding:0 10px; font-size:var(--fs-xs); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'seg');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * SegmentedControl — pick one of a few mutually-exclusive options. Used for
 * time ranges (Day/Week/Month/Year) and view switches across the product.
 */
function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  block = false,
  className = '',
  ...rest
}) {
  inject();
  const cls = ['pwr-seg', size === 'sm' && 'pwr-seg--sm', block && 'pwr-seg--block', className].filter(Boolean).join(' ');
  const norm = options.map(o => typeof o === 'string' ? {
    value: o,
    label: o
  } : o);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "tablist"
  }, rest), norm.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "tab",
    "aria-selected": o.value === value,
    className: "pwr-seg__opt",
    onClick: () => onChange && onChange(o.value)
  }, o.icon, o.label)));
}
Object.assign(__ds_scope, { SegmentedControl });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/SegmentedControl.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-select-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-select-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-select-wrap{ position:relative; display:flex; align-items:center; }
.pwr-select{ width:100%; height:var(--control-md); padding:0 38px 0 12px;
  background:var(--surface-2); color:var(--text-1); cursor:pointer;
  border:1px solid var(--border-2); border-radius:var(--radius-md);
  font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1;
  -webkit-appearance:none; appearance:none;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pwr-select:hover{ border-color:var(--border-3); }
.pwr-select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(46,230,160,0.18); }
.pwr-select:disabled{ opacity:0.5; cursor:not-allowed; }
.pwr-select__chev{ position:absolute; right:12px; display:inline-flex; color:var(--text-3); pointer-events:none; }
.pwr-select__chev svg{ width:16px; height:16px; }
.pwr-select option{ background:var(--surface-2); color:var(--text-1); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'select');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const Chevron = () => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "6 9 12 15 18 9"
}));

/**
 * Select — native dropdown styled to the system. Options as strings or
 * {value,label} objects.
 */
function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder,
  id,
  className = '',
  ...rest
}) {
  inject();
  const fid = id || (label ? 'pwr-' + Math.random().toString(36).slice(2, 8) : undefined);
  const norm = options.map(o => typeof o === 'string' ? {
    value: o,
    label: o
  } : o);
  return /*#__PURE__*/React.createElement("div", {
    className: "pwr-select-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "pwr-select-field__label",
    htmlFor: fid
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "pwr-select-wrap"
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: fid,
    className: ['pwr-select', className].filter(Boolean).join(' '),
    value: value,
    onChange: onChange
  }, rest), placeholder && /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, placeholder), norm.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), /*#__PURE__*/React.createElement("span", {
    className: "pwr-select__chev"
  }, /*#__PURE__*/React.createElement(Chevron, null))));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Slider.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-slider{ display:flex; flex-direction:column; gap:8px; width:100%; }
.pwr-slider__top{ display:flex; align-items:baseline; justify-content:space-between; }
.pwr-slider__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-slider__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-slider__input{ -webkit-appearance:none; appearance:none; width:100%; height:22px;
  background:transparent; cursor:pointer; margin:0; }
.pwr-slider__input::-webkit-slider-runnable-track{ height:6px; border-radius:var(--radius-pill);
  background:linear-gradient(to right, var(--accent) var(--_pct,50%), var(--surface-4) var(--_pct,50%)); }
.pwr-slider__input::-moz-range-track{ height:6px; border-radius:var(--radius-pill); background:var(--surface-4); }
.pwr-slider__input::-moz-range-progress{ height:6px; border-radius:var(--radius-pill); background:var(--accent); }
.pwr-slider__input::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none;
  width:16px; height:16px; margin-top:-5px; border-radius:50%; background:#eafff6;
  border:3px solid var(--accent); box-shadow:var(--glow-soft);
  transition:transform var(--dur-fast) var(--ease-out); }
.pwr-slider__input::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#eafff6;
  border:3px solid var(--accent); box-shadow:var(--glow-soft); }
.pwr-slider__input:active::-webkit-slider-thumb{ transform:scale(1.18); }
.pwr-slider__input:focus-visible{ outline:none; }
.pwr-slider__input:focus-visible::-webkit-slider-thumb{ box-shadow:var(--focus-ring); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'slider');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Slider — continuous value control (charge limits, reserve %, thresholds).
 * Tracks fill with solar accent up to the current value.
 */
function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  unit = '',
  showValue = true,
  formatValue,
  className = '',
  ...rest
}) {
  inject();
  const v = value ?? min;
  const pct = (v - min) / (max - min) * 100;
  const display = formatValue ? formatValue(v) : `${v}${unit}`;
  return /*#__PURE__*/React.createElement("div", {
    className: ['pwr-slider', className].filter(Boolean).join(' ')
  }, (label || showValue) && /*#__PURE__*/React.createElement("div", {
    className: "pwr-slider__top"
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "pwr-slider__label"
  }, label), showValue && /*#__PURE__*/React.createElement("span", {
    className: "pwr-slider__val"
  }, display)), /*#__PURE__*/React.createElement("input", _extends({
    className: "pwr-slider__input",
    type: "range",
    min: min,
    max: max,
    step: step,
    value: v,
    onChange: e => onChange && onChange(Number(e.target.value), e),
    style: {
      '--_pct': pct + '%'
    }
  }, rest)));
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Slider.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.pwr-switch{ display:inline-flex; align-items:center; gap:10px; cursor:pointer; user-select:none; }
.pwr-switch input{ position:absolute; opacity:0; width:0; height:0; }
.pwr-switch__track{ position:relative; width:42px; height:24px; flex:none;
  background:var(--surface-4); border:1px solid var(--border-2); border-radius:var(--radius-pill);
  transition:background var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out),
             box-shadow var(--dur) var(--ease-out); }
.pwr-switch__thumb{ position:absolute; top:50%; left:3px; width:16px; height:16px; border-radius:50%;
  background:var(--text-2); transform:translateY(-50%);
  transition:transform var(--dur) var(--ease-spring), background var(--dur) var(--ease-out); }
.pwr-switch input:checked + .pwr-switch__track{ background:var(--accent); border-color:transparent; box-shadow:var(--glow-soft); }
.pwr-switch input:checked + .pwr-switch__track .pwr-switch__thumb{ transform:translate(18px,-50%); background:var(--accent-contrast); }
.pwr-switch input:focus-visible + .pwr-switch__track{ box-shadow:var(--focus-ring); }
.pwr-switch input:disabled + .pwr-switch__track{ opacity:0.4; }
.pwr-switch:has(input:disabled){ cursor:not-allowed; }
.pwr-switch__label{ font-size:var(--fs-sm); color:var(--text-1); }
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'switch');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Switch — boolean toggle for settings & automation. Solar fill = on.
 */
function Switch({
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  label,
  className = '',
  ...rest
}) {
  inject();
  return /*#__PURE__*/React.createElement("label", {
    className: ['pwr-switch', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch",
    checked: checked,
    defaultChecked: defaultChecked,
    onChange: onChange,
    disabled: disabled
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "pwr-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pwr-switch__thumb"
  })), label && /*#__PURE__*/React.createElement("span", {
    className: "pwr-switch__label"
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/App.jsx
try { (() => {
// Power desktop kit — App shell wiring screens together.
function App() {
  const {
    drawIcons
  } = window.PWRKit;
  const [active, setActive] = React.useState('overview');
  const [range, setRange] = React.useState('Day');
  React.useEffect(() => {
    drawIcons();
  });
  const titles = {
    overview: ['Overview', 'Your home, right now'],
    statistics: ['Statistics', 'Production, consumption & savings'],
    devices: ['Devices', 'Monitor & control connected hardware'],
    optimization: ['Optimization', 'Automation rules & battery strategy'],
    settings: ['Settings', 'System configuration']
  };
  const [title, sub] = titles[active] || titles.overview;
  let Screen;
  if (active === 'overview') Screen = /*#__PURE__*/React.createElement(window.OverviewScreen, null);else if (active === 'statistics') Screen = /*#__PURE__*/React.createElement(window.StatisticsScreen, {
    range: range
  });else if (active === 'devices') Screen = /*#__PURE__*/React.createElement(window.DevicesScreen, null);else if (active === 'optimization') Screen = /*#__PURE__*/React.createElement(window.OptimizationScreen, null);else Screen = /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text-2)',
      padding: 40
    }
  }, "Settings \u2014 configuration screens.");
  const showRange = active === 'statistics';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100vh',
      width: '100%',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement(window.Sidebar, {
    active: active,
    onNav: setActive
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      background: 'var(--bg-0)'
    }
  }, /*#__PURE__*/React.createElement(window.TopBar, {
    title: title,
    subtitle: sub,
    range: showRange ? range : null,
    onRange: setRange
  }), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '24px 28px 40px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--content-max)',
      margin: '0 auto'
    }
  }, Screen))));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
setTimeout(() => window.lucide && window.lucide.createIcons(), 80);
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/Chrome.jsx
try { (() => {
// Power desktop kit — Sidebar + TopBar chrome.
function Sidebar({
  active,
  onNav
}) {
  const {
    DATA
  } = window.PWRKit;
  const {
    StatusDot
  } = window.PowerDesignSystem_138199;
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 'var(--sidebar-w)',
      flex: 'none',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-1)',
      borderRight: '1px solid var(--border-1)',
      padding: '20px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      padding: '4px 8px 22px'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-mark.svg",
    width: "34",
    height: "34",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 19,
      fontWeight: 700,
      letterSpacing: '-0.02em'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--solar)'
    }
  }, "Power"))), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 3
    }
  }, DATA.nav.map(n => {
    const on = active === n.id;
    return /*#__PURE__*/React.createElement("button", {
      key: n.id,
      onClick: () => onNav(n.id),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        height: 42,
        padding: '0 12px',
        border: 'none',
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)',
        textAlign: 'left',
        background: on ? 'var(--solar-wash)' : 'transparent',
        color: on ? 'var(--solar)' : 'var(--text-2)',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        fontWeight: on ? 600 : 500,
        boxShadow: on ? 'inset 2px 0 0 var(--solar)' : 'none',
        transition: 'background .12s, color .12s'
      }
    }, /*#__PURE__*/React.createElement("i", {
      "data-lucide": n.icon,
      style: {
        width: 18,
        height: 18
      }
    }), n.label);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--surface-1)',
      border: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "pwr-eyebrow"
  }, "System"), /*#__PURE__*/React.createElement(StatusDot, {
    tone: "solar",
    live: true
  }, "Online")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-2)',
      lineHeight: 1.7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", null, "Uptime"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-1)'
    }
  }, "41d 6h")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", null, "Firmware"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-1)'
    }
  }, "v3.8.1")))), /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav('settings'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      height: 40,
      padding: '0 12px',
      border: 'none',
      cursor: 'pointer',
      borderRadius: 'var(--radius-md)',
      background: 'transparent',
      color: 'var(--text-2)',
      fontFamily: 'var(--font-sans)',
      fontSize: 14,
      fontWeight: 500
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "settings",
    style: {
      width: 18,
      height: 18
    }
  }), "Settings")));
}
function TopBar({
  title,
  subtitle,
  range,
  onRange,
  right
}) {
  const {
    SegmentedControl,
    IconButton
  } = window.PowerDesignSystem_138199;
  return /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      padding: '20px 28px',
      borderBottom: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 22,
      fontWeight: 600,
      letterSpacing: '-0.01em'
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-2)',
      marginTop: 2
    }
  }, subtitle)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, right, range && /*#__PURE__*/React.createElement(SegmentedControl, {
    options: ['Day', 'Week', 'Month', 'Year'],
    value: range,
    onChange: onRange,
    size: "sm"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-1)',
      border: '1px solid var(--border-1)',
      fontSize: 13,
      color: 'var(--text-2)'
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "cloud-sun",
    style: {
      width: 16,
      height: 16,
      color: 'var(--grid)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)'
    }
  }, "18\xB0"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-3)'
    }
  }, "\xB7 Partly sunny")), /*#__PURE__*/React.createElement(IconButton, {
    label: "Notifications",
    variant: "solid"
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "bell"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: 'linear-gradient(135deg, var(--solar-dim), var(--battery-dim))',
      display: 'grid',
      placeItems: 'center',
      fontWeight: 700,
      fontSize: 13,
      color: '#fff'
    }
  }, "JD")));
}
Object.assign(window, {
  Sidebar,
  TopBar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/Chrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/DevicesScreen.jsx
try { (() => {
// Power desktop kit — Devices screen.
function DevicesScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    StatusDot,
    Switch,
    Badge,
    Button,
    IconButton,
    RadialGauge,
    StatTile,
    ProgressBar
  } = window.PowerDesignSystem_138199;
  const [selected, setSelected] = React.useState('ev');
  const dev = DATA.devices.find(d => d.id === selected) || DATA.devices[0];
  const toneVar = {
    solar: 'var(--solar)',
    battery: 'var(--battery)',
    grid: 'var(--grid)',
    home: 'var(--home)',
    ev: 'var(--ev)'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.3fr 1fr',
      gap: 20,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Connected devices",
    subtitle: `${DATA.devices.length} devices · 4 active`,
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "cpu"
    }),
    actions: /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "sm",
      iconLeft: /*#__PURE__*/React.createElement("i", {
        "data-lucide": "plus"
      })
    }, "Add")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, DATA.devices.map((d, i) => {
    const on = d.id === selected;
    return /*#__PURE__*/React.createElement("button", {
      key: d.id,
      onClick: () => setSelected(d.id),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 8px',
        cursor: 'pointer',
        background: on ? 'var(--surface-2)' : 'transparent',
        border: 'none',
        textAlign: 'left',
        borderTop: i === 0 ? 'none' : '1px solid var(--border-1)',
        borderRadius: on ? 'var(--radius-md)' : 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 40,
        height: 40,
        borderRadius: 11,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--surface-3)',
        color: toneVar[d.tone],
        flex: 'none'
      }
    }, /*#__PURE__*/React.createElement("i", {
      "data-lucide": d.icon,
      style: {
        width: 19,
        height: 19
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14.5,
        fontWeight: 600,
        color: 'var(--text-1)'
      }
    }, d.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: 'var(--text-2)'
      }
    }, d.sub)), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: 'right'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 15,
        fontWeight: 500,
        color: d.kw > 0 ? toneVar[d.tone] : 'var(--text-3)'
      }
    }, d.kw.toFixed(2), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: 'var(--text-3)'
      }
    }, " kW")), /*#__PURE__*/React.createElement(StatusDot, {
      tone: d.live ? d.tone : 'offline',
      live: d.live
    }, d.state.split(' · ')[0])));
  }))), /*#__PURE__*/React.createElement(Card, {
    accent: dev.tone,
    glow: dev.live,
    title: dev.name,
    subtitle: dev.sub,
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": dev.icon
    }),
    actions: /*#__PURE__*/React.createElement(IconButton, {
      label: "Device settings"
    }, /*#__PURE__*/React.createElement("i", {
      "data-lucide": "settings-2"
    }))
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 20
    }
  }, dev.id === 'ev' || dev.id === 'bat' ? /*#__PURE__*/React.createElement(RadialGauge, {
    value: dev.id === 'ev' ? 62 : 78,
    tone: dev.tone,
    label: dev.id === 'ev' ? 'Charge' : 'SOC',
    size: 120
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      width: 120,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 40,
      fontWeight: 500,
      color: toneVar[dev.tone]
    }
  }, dev.kw.toFixed(1)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, "kW now")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--text-2)'
    }
  }, "Power"), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: dev.on,
    label: dev.on ? 'On' : 'Off'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--text-2)'
    }
  }, "Status"), /*#__PURE__*/React.createElement(Badge, {
    tone: dev.live ? dev.tone : 'neutral',
    variant: dev.live ? 'soft' : 'soft'
  }, dev.state)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--text-2)'
    }
  }, "Today"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      color: 'var(--text-1)'
    }
  }, "14.2 kWh")))), dev.id === 'ev' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 16,
      borderTop: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement(ProgressBar, {
    label: "Charge to 80%",
    value: 62,
    max: 80,
    tone: "ev",
    showValue: true,
    glow: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconLeft: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "zap"
    }),
    block: true
  }, "Charge now"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm",
    iconLeft: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "clock"
    }),
    block: true
  }, "Schedule"))))));
}
Object.assign(window, {
  DevicesScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/DevicesScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/OptimizationScreen.jsx
try { (() => {
// Power desktop kit — Optimization screen.
function OptimizationScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    Switch,
    Slider,
    Select,
    Badge,
    Button
  } = window.PowerDesignSystem_138199;
  const [rules, setRules] = React.useState(DATA.rules);
  const [reserve, setReserve] = React.useState(20);
  const [mode, setMode] = React.useState('Self-use');
  const toggle = id => setRules(rs => rs.map(r => r.id === id ? {
    ...r,
    on: !r.on
  } : r));
  const tariffColor = ['var(--solar)', 'var(--surface-4)', 'var(--grid)'];
  const tariffName = ['Cheap', 'Normal', 'Peak'];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.2fr 1fr',
      gap: 20,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Automation rules",
    subtitle: "3 of 5 active",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "workflow"
    }),
    actions: /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "sm",
      iconLeft: /*#__PURE__*/React.createElement("i", {
        "data-lucide": "plus"
      })
    }, "New rule")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, rules.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      padding: '16px 4px',
      borderTop: i === 0 ? 'none' : '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 38,
      height: 38,
      borderRadius: 10,
      display: 'grid',
      placeItems: 'center',
      flex: 'none',
      background: r.on ? 'var(--solar-wash)' : 'var(--surface-3)',
      color: r.on ? 'var(--solar)' : 'var(--text-3)'
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": r.icon,
    style: {
      width: 18,
      height: 18
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14.5,
      fontWeight: 600,
      color: 'var(--text-1)'
    }
  }, r.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--text-2)',
      marginTop: 2,
      lineHeight: 1.5
    }
  }, r.desc)), /*#__PURE__*/React.createElement(Switch, {
    checked: r.on,
    onChange: () => toggle(r.id)
  }))))), /*#__PURE__*/React.createElement(Card, {
    title: "Grid tariff \xB7 today",
    subtitle: "Optimizer shifts loads to cheap windows",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "clock"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      height: 56,
      alignItems: 'stretch',
      marginBottom: 10
    }
  }, DATA.tariff.map((t, h) => /*#__PURE__*/React.createElement("div", {
    key: h,
    title: `${h}:00 · ${tariffName[t]}`,
    style: {
      flex: 1,
      background: tariffColor[t],
      borderRadius: 3,
      opacity: t === 1 ? 0.5 : 1,
      boxShadow: t === 0 ? '0 0 8px color-mix(in srgb, var(--solar) 40%, transparent)' : 'none'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--text-3)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "00:00"), /*#__PURE__*/React.createElement("span", null, "06:00"), /*#__PURE__*/React.createElement("span", null, "12:00"), /*#__PURE__*/React.createElement("span", null, "18:00"), /*#__PURE__*/React.createElement("span", null, "24:00")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      marginTop: 14,
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, tariffName.map((n, i) => /*#__PURE__*/React.createElement("span", {
    key: n,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 3,
      background: tariffColor[i],
      opacity: i === 1 ? 0.5 : 1
    }
  }), n))))), /*#__PURE__*/React.createElement(Card, {
    title: "Battery strategy",
    subtitle: "How storage charges & discharges",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "battery-charging"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 22
    }
  }, /*#__PURE__*/React.createElement(Select, {
    label: "Charge mode",
    options: ['Self-use', 'Time-of-use', 'Backup', 'Manual'],
    value: mode,
    onChange: e => setMode(e.target.value)
  }), /*#__PURE__*/React.createElement(Slider, {
    label: "Reserve for backup",
    unit: "%",
    value: reserve,
    onChange: setReserve
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      paddingTop: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--text-1)'
    }
  }, "Charge from grid"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, "Top up at cheap rate overnight")), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--text-1)'
    }
  }, "Sell surplus to grid"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, "Export above ", reserve, "% reserve")), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: true
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 14,
      borderRadius: 'var(--radius-md)',
      background: 'var(--solar-wash)',
      border: '1px solid rgba(46,230,160,0.2)',
      display: 'flex',
      gap: 11,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "sparkles",
    style: {
      width: 18,
      height: 18,
      color: 'var(--solar)',
      flex: 'none',
      marginTop: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-1)',
      lineHeight: 1.5
    }
  }, "Optimizer estimates ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--solar)'
    }
  }, "\u20AC41/mo"), " saved with the current strategy.")), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconLeft: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "check"
    }),
    block: true
  }, "Apply strategy"))));
}
Object.assign(window, {
  OptimizationScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/OptimizationScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/OverviewScreen.jsx
try { (() => {
// Power desktop kit — Overview screen.
function OverviewScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    StatTile,
    RadialGauge,
    EnergyFlow,
    ProgressBar,
    Sparkline,
    Badge
  } = window.PowerDesignSystem_138199;
  const {
    AreaChart
  } = window.PWRCharts;
  const t = DATA.today;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.15fr 1fr',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Live energy flow",
    subtitle: "Updated just now",
    accent: "solar",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "zap"
    }),
    actions: /*#__PURE__*/React.createElement(Badge, {
      tone: "solar",
      variant: "soft",
      icon: /*#__PURE__*/React.createElement("i", {
        "data-lucide": "radio"
      })
    }, "Live")
  }, /*#__PURE__*/React.createElement(EnergyFlow, {
    solar: DATA.live.solar,
    battery: DATA.live.battery,
    grid: DATA.live.grid,
    home: DATA.live.home
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    glow: true,
    accent: "solar"
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Solar now",
    value: "4.21",
    unit: "kW",
    tone: "solar",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "sun"
    }),
    footnote: "6.2 kW peak today"
  })), /*#__PURE__*/React.createElement(Card, {
    accent: "home"
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Home load",
    value: "2.25",
    unit: "kW",
    tone: "home",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "house"
    }),
    delta: -4,
    footnote: "vs 1h ago"
  })), /*#__PURE__*/React.createElement(Card, {
    style: {
      gridColumn: 'span 2'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 22
    }
  }, /*#__PURE__*/React.createElement(RadialGauge, {
    value: DATA.live.battery.soc,
    tone: "battery",
    label: "Battery",
    size: 120
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Storage",
    value: "10.5",
    unit: "kWh",
    tone: "battery",
    footnote: "of 13.5 kWh \xB7 charging 1.1 kW"
  }), /*#__PURE__*/React.createElement(ProgressBar, {
    height: 6,
    segments: [{
      value: t.selfSufficiency,
      tone: 'solar'
    }, {
      value: 100 - t.selfSufficiency,
      tone: 'grid'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--solar)'
    }
  }, t.selfSufficiency, "% solar"), " \xB7 ", 100 - t.selfSufficiency, "% grid")))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Produced today",
    value: t.produced,
    unit: "kWh",
    tone: "solar",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "sun"
    }),
    delta: 12,
    footnote: "vs yesterday"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: DATA.solarDay.filter((_, i) => i % 2 === 0),
    tone: "solar",
    width: 220,
    height: 34
  }))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Consumed",
    value: t.consumed,
    unit: "kWh",
    tone: "home",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "plug"
    }),
    delta: -6,
    footnote: "vs yesterday"
  }, /*#__PURE__*/React.createElement(Sparkline, {
    data: DATA.homeDay.filter((_, i) => i % 2 === 0),
    tone: "home",
    width: 220,
    height: 34
  }))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Self-sufficiency",
    value: t.selfSufficiency,
    unit: "%",
    tone: "battery",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "leaf"
    }),
    delta: 5,
    footnote: "vs avg"
  })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Saved today",
    value: `€${t.savings}`,
    tone: "solar",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "piggy-bank"
    }),
    delta: 9,
    footnote: "vs grid-only"
  }))), /*#__PURE__*/React.createElement(Card, {
    title: "Production & consumption",
    subtitle: "Today \xB7 kW",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "area-chart"
    }),
    actions: /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 16,
        fontSize: 12,
        color: 'var(--text-2)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--solar)'
      }
    }), "Solar"), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--home)'
      }
    }), "Home"))
  }, /*#__PURE__*/React.createElement(AreaChart, {
    height: 200,
    series: [{
      data: DATA.solarDay,
      tone: 'solar'
    }, {
      data: DATA.homeDay,
      tone: 'home',
      dash: true,
      fill: false
    }],
    labels: ['00', '04', '08', '12', '16', '20', '24']
  })));
}
Object.assign(window, {
  OverviewScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/OverviewScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/StatisticsScreen.jsx
try { (() => {
// Power desktop kit — Statistics screen.
function StatisticsScreen({
  range
}) {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    StatTile,
    ProgressBar,
    Badge
  } = window.PowerDesignSystem_138199;
  const {
    BarChart
  } = window.PWRCharts;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const prod = [31, 26, 38, 22, 34, 41, 29];
  const cons = [22, 19, 24, 18, 21, 17, 20];
  const groups = days.map((d, i) => ({
    label: d,
    values: [prod[i], cons[i]],
    tones: ['var(--solar)', 'var(--home)']
  }));
  const breakdown = [{
    name: 'EV charger',
    icon: 'plug-zap',
    tone: 'var(--ev)',
    kwh: 58.2,
    pct: 38
  }, {
    name: 'Heat pump',
    icon: 'thermometer',
    tone: 'var(--grid)',
    kwh: 42.6,
    pct: 28
  }, {
    name: 'Appliances',
    icon: 'washing-machine',
    tone: 'var(--home)',
    kwh: 28.1,
    pct: 18
  }, {
    name: 'Water heater',
    icon: 'droplet',
    tone: 'var(--battery)',
    kwh: 15.3,
    pct: 10
  }, {
    name: 'Lighting & other',
    icon: 'lightbulb',
    tone: 'var(--text-2)',
    kwh: 9.0,
    pct: 6
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Produced",
    value: "221",
    unit: "kWh",
    tone: "solar",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "sun"
    }),
    delta: 8,
    footnote: "this week"
  })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Consumed",
    value: "141",
    unit: "kWh",
    tone: "home",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "plug"
    }),
    delta: -3,
    footnote: "this week"
  })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "Exported",
    value: "96",
    unit: "kWh",
    tone: "grid",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "upload"
    }),
    delta: 14,
    footnote: "to grid"
  })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(StatTile, {
    label: "CO\u2082 avoided",
    value: "88",
    unit: "kg",
    tone: "battery",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "leaf"
    }),
    delta: 8,
    footnote: "this week"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.5fr 1fr',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Production vs consumption",
    subtitle: `This ${range === 'Day' ? 'day' : 'week'} · kWh`,
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "bar-chart-3"
    }),
    actions: /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 16,
        fontSize: 12,
        color: 'var(--text-2)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--solar)'
      }
    }), "Produced"), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--home)'
      }
    }), "Consumed"))
  }, /*#__PURE__*/React.createElement(BarChart, {
    groups: groups,
    height: 240
  })), /*#__PURE__*/React.createElement(Card, {
    title: "Consumption breakdown",
    subtitle: "By device \xB7 this week",
    icon: /*#__PURE__*/React.createElement("i", {
      "data-lucide": "pie-chart"
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16
    }
  }, breakdown.map(b => /*#__PURE__*/React.createElement("div", {
    key: b.name,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 8,
      display: 'grid',
      placeItems: 'center',
      background: 'var(--surface-3)',
      color: b.tone
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": b.icon,
    style: {
      width: 15,
      height: 15
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--text-1)',
      flex: 1
    }
  }, b.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      color: 'var(--text-1)'
    }
  }, b.kwh, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-3)'
    }
  }, "kWh"))), /*#__PURE__*/React.createElement(ProgressBar, {
    height: 6,
    segments: [{
      value: b.pct,
      tone: b.tone
    }]
  })))))));
}
Object.assign(window, {
  StatisticsScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/StatisticsScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/charts.jsx
try { (() => {
// Power desktop kit — charts (SVG). Exposes window.PWRCharts.
const PWRCharts = function () {
  const TONE = {
    solar: 'var(--solar)',
    battery: 'var(--battery)',
    grid: 'var(--grid)',
    home: 'var(--home)',
    ev: 'var(--ev)'
  };
  let gid = 0;
  function buildPath(data, w, h, padY) {
    const max = Math.max(...data, 1);
    const stepX = w / (data.length - 1);
    const pts = data.map((d, i) => [i * stepX, h - padY - d / max * (h - padY * 2)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    return {
      line,
      pts,
      max
    };
  }

  // Multi-series area/line chart with hour axis + y gridlines.
  function AreaChart({
    series,
    height = 220,
    unit = 'kW',
    labels
  }) {
    const w = 1000;
    const h = height;
    const padY = 16;
    const id0 = React.useMemo(() => 'pwrc' + gid++, []);
    const allMax = Math.max(...series.flatMap(s => s.data), 1);
    const stepX = w / (series[0].data.length - 1);
    const gridY = [0, 0.25, 0.5, 0.75, 1];
    const niceMax = Math.ceil(allMax);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        width: '100%'
      }
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: `0 0 ${w} ${h + 26}`,
      width: "100%",
      preserveAspectRatio: "none",
      style: {
        display: 'block',
        overflow: 'visible'
      }
    }, /*#__PURE__*/React.createElement("defs", null, series.map((s, i) => /*#__PURE__*/React.createElement("linearGradient", {
      key: i,
      id: `${id0}-${i}`,
      x1: "0",
      y1: "0",
      x2: "0",
      y2: "1"
    }, /*#__PURE__*/React.createElement("stop", {
      offset: "0%",
      stopColor: TONE[s.tone] || s.tone,
      stopOpacity: "0.28"
    }), /*#__PURE__*/React.createElement("stop", {
      offset: "100%",
      stopColor: TONE[s.tone] || s.tone,
      stopOpacity: "0"
    })))), gridY.map((g, i) => /*#__PURE__*/React.createElement("g", {
      key: i
    }, /*#__PURE__*/React.createElement("line", {
      x1: "0",
      y1: padY + g * (h - padY * 2),
      x2: w,
      y2: padY + g * (h - padY * 2),
      stroke: "var(--grid-line)",
      strokeWidth: "1"
    }), /*#__PURE__*/React.createElement("text", {
      x: "6",
      y: padY + g * (h - padY * 2) - 5,
      fill: "var(--text-3)",
      style: {
        font: '500 16px var(--font-mono)'
      }
    }, Math.round(niceMax * (1 - g))))), series.map((s, i) => {
      const max = niceMax;
      const pts = s.data.map((d, j) => [j * stepX, padY + (1 - d / max) * (h - padY * 2)]);
      const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      const fill = `${line} L${w} ${h - padY} L0 ${h - padY} Z`;
      return /*#__PURE__*/React.createElement("g", {
        key: i
      }, s.fill !== false && /*#__PURE__*/React.createElement("path", {
        d: fill,
        fill: `url(#${id0}-${i})`
      }), /*#__PURE__*/React.createElement("path", {
        d: line,
        fill: "none",
        stroke: TONE[s.tone] || s.tone,
        strokeWidth: s.dash ? 2 : 2.5,
        strokeDasharray: s.dash ? '5 5' : undefined,
        strokeLinejoin: "round",
        strokeLinecap: "round",
        vectorEffect: "non-scaling-stroke"
      }));
    }), (labels || ['00', '06', '12', '18', '24']).map((lb, i, arr) => /*#__PURE__*/React.createElement("text", {
      key: i,
      x: i / (arr.length - 1) * w,
      y: h + 18,
      textAnchor: i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle',
      fill: "var(--text-3)",
      style: {
        font: '500 15px var(--font-mono)'
      }
    }, lb))));
  }

  // Vertical bar chart (e.g. weekly production vs consumption).
  function BarChart({
    groups,
    height = 220,
    labels
  }) {
    const max = Math.max(...groups.flatMap(g => g.values), 1);
    const niceMax = Math.ceil(max);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-end',
        gap: 18,
        height,
        padding: '0 4px',
        borderBottom: '1px solid var(--border-1)'
      }
    }, groups.map((g, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        height: '100%'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 5,
        width: '100%',
        justifyContent: 'center'
      }
    }, g.values.map((v, j) => /*#__PURE__*/React.createElement("div", {
      key: j,
      title: `${v} kWh`,
      style: {
        width: 16,
        height: `${v / niceMax * 100}%`,
        minHeight: 3,
        background: g.tones[j],
        borderRadius: '4px 4px 0 0',
        boxShadow: j === 0 ? '0 0 10px color-mix(in srgb,' + g.tones[j] + ' 40%, transparent)' : 'none'
      }
    })))))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 18,
        padding: '0 4px'
      }
    }, (labels || groups.map(g => g.label)).map((lb, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        flex: 1,
        textAlign: 'center',
        font: '500 13px var(--font-mono)',
        color: 'var(--text-3)'
      }
    }, lb))));
  }
  return {
    AreaChart,
    BarChart
  };
}();
Object.assign(window, {
  PWRCharts
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/charts.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/data.js
try { (() => {
// Power desktop kit — mock data + helpers. Plain JS, exposes globals.
(function () {
  const NS = window.PowerDesignSystem_138199 || {};

  // Re-run Lucide after React renders (icons use <i data-lucide>).
  function drawIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  // Smooth-ish series generator
  function series(n, base, amp, seed) {
    let s = seed || 1;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const out = [];
    for (let i = 0; i < n; i++) {
      const day = Math.sin(i / n * Math.PI); // bell over the day
      out.push(Math.max(0, base + day * amp + (rnd() - 0.5) * amp * 0.3));
    }
    return out;
  }
  const hours = Array.from({
    length: 24
  }, (_, i) => i);
  const DATA = {
    live: {
      solar: {
        kw: 4.21
      },
      battery: {
        kw: 1.12,
        dir: 'charging',
        soc: 78
      },
      grid: {
        kw: 0.84,
        dir: 'exporting'
      },
      home: {
        kw: 2.25
      }
    },
    today: {
      produced: 28.4,
      consumed: 19.7,
      selfSufficiency: 74,
      savings: 6.85,
      exported: 9.1,
      imported: 4.3,
      co2: 12.6
    },
    solarDay: series(24, 0.2, 5.4, 7).map((v, i) => i < 6 || i > 20 ? 0 : v),
    homeDay: series(24, 0.4, 1.6, 13),
    hours,
    devices: [{
      id: 'pv',
      name: 'Solar inverter',
      sub: 'SolarEdge SE7600',
      icon: 'sun',
      tone: 'solar',
      kw: 4.21,
      state: 'Producing',
      live: true,
      on: true
    }, {
      id: 'bat',
      name: 'Home battery',
      sub: 'Powerwall · 13.5 kWh',
      icon: 'battery-charging',
      tone: 'battery',
      kw: 1.12,
      state: 'Charging · 78%',
      live: true,
      on: true
    }, {
      id: 'ev',
      name: 'EV charger',
      sub: 'Wallbox · Garage',
      icon: 'plug-zap',
      tone: 'ev',
      kw: 7.4,
      state: 'Charging · 62%',
      live: true,
      on: true
    }, {
      id: 'hp',
      name: 'Heat pump',
      sub: 'Daikin Altherma',
      icon: 'thermometer',
      tone: 'grid',
      kw: 0.9,
      state: 'Heating · 21°C',
      live: true,
      on: true
    }, {
      id: 'wh',
      name: 'Water heater',
      sub: 'Boiler · 200 L',
      icon: 'droplet',
      tone: 'home',
      kw: 0,
      state: 'Idle',
      live: false,
      on: true
    }, {
      id: 'grid',
      name: 'Grid connection',
      sub: 'Liander · 3×25 A',
      icon: 'utility-pole',
      tone: 'grid',
      kw: 0.84,
      state: 'Exporting',
      live: true,
      on: true
    }],
    rules: [{
      id: 'r1',
      name: 'Battery-first charging',
      desc: 'Charge the battery from surplus solar before exporting to the grid.',
      on: true,
      icon: 'battery-charging'
    }, {
      id: 'r2',
      name: 'Cheap-rate EV top-up',
      desc: 'Charge the car between 02:00–05:00 when grid tariff is lowest.',
      on: true,
      icon: 'plug-zap'
    }, {
      id: 'r3',
      name: 'Storm guard',
      desc: 'Reserve 100% battery capacity when a storm warning is issued.',
      on: false,
      icon: 'cloud-lightning'
    }, {
      id: 'r4',
      name: 'Peak shaving',
      desc: 'Discharge battery to cap grid import below 4 kW during peak hours.',
      on: true,
      icon: 'activity'
    }, {
      id: 'r5',
      name: 'Heat-pump preheat',
      desc: 'Pre-heat the house on solar surplus before the evening peak.',
      on: false,
      icon: 'thermometer'
    }],
    // 24h tariff: 0 cheap, 1 normal, 2 peak
    tariff: [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 0, 0],
    nav: [{
      id: 'overview',
      label: 'Overview',
      icon: 'layout-dashboard'
    }, {
      id: 'statistics',
      label: 'Statistics',
      icon: 'bar-chart-3'
    }, {
      id: 'devices',
      label: 'Devices',
      icon: 'cpu'
    }, {
      id: 'optimization',
      label: 'Optimization',
      icon: 'sliders-horizontal'
    }]
  };
  window.PWRKit = Object.assign(window.PWRKit || {}, {
    DATA,
    drawIcons,
    series
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/data.js", error: String((e && e.message) || e) }); }

// ui_kits/mobile/MobileApp.jsx
try { (() => {
// Power mobile kit — phone frame + screens.
const I = (n, s) => /*#__PURE__*/React.createElement("i", {
  "data-lucide": n,
  style: s
});
function StatusBar() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 26px 4px',
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      color: 'var(--text-1)',
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement("span", null, "9:41"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, I('signal', {
    width: 16,
    height: 16
  }), I('wifi', {
    width: 16,
    height: 16
  }), I('battery-full', {
    width: 18,
    height: 18
  })));
}
function MHeader({
  title,
  sub,
  action
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '14px 20px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 24,
      fontWeight: 700,
      letterSpacing: '-0.02em'
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-2)',
      marginTop: 2
    }
  }, sub)), action);
}
function HomeScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    StatTile,
    EnergyFlow,
    RadialGauge,
    Switch,
    Badge
  } = window.PowerDesignSystem_138199;
  const t = DATA.today;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(MHeader, {
    title: "Good afternoon",
    sub: "Home \xB7 sunny, 18\xB0",
    action: /*#__PURE__*/React.createElement("div", {
      style: {
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--solar-dim), var(--battery-dim))',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: 13,
        color: '#fff'
      }
    }, "JD")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '0 16px 24px'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    accent: "solar",
    glow: true,
    padded: false,
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "pwr-eyebrow"
  }, "Live flow"), /*#__PURE__*/React.createElement(Badge, {
    tone: "solar",
    icon: I('radio', {
      width: 12,
      height: 12
    })
  }, "Live")), /*#__PURE__*/React.createElement(EnergyFlow, {
    solar: DATA.live.solar,
    battery: DATA.live.battery,
    grid: DATA.live.grid,
    home: DATA.live.home
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Solar today",
    value: t.produced,
    unit: "kWh",
    tone: "solar",
    icon: I('sun'),
    delta: 12
  })), /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Used",
    value: t.consumed,
    unit: "kWh",
    tone: "home",
    icon: I('plug'),
    delta: -6
  }))), /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 18
    }
  }, /*#__PURE__*/React.createElement(RadialGauge, {
    value: DATA.live.battery.soc,
    tone: "battery",
    label: "Battery",
    size: 104
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Storage",
    value: "10.5",
    unit: "kWh",
    tone: "battery",
    footnote: "charging 1.1 kW"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-2)'
    }
  }, "Self-sufficiency"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      color: 'var(--solar)'
    }
  }, t.selfSufficiency, "%"))))), /*#__PURE__*/React.createElement(Card, {
    title: "Quick controls",
    style: {
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, [['plug-zap', 'EV charging', 'ev', true], ['battery-charging', 'Battery export', 'battery', true], ['cloud-lightning', 'Storm guard', 'grid', false]].map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '13px 16px',
      borderTop: i ? '1px solid var(--border-1)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: `var(--${r[2]})`
    }
  }, I(r[0], {
    width: 18,
    height: 18
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 14.5
    }
  }, r[1]), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: r[3]
  })))))));
}
function FlowScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    EnergyFlow,
    StatTile,
    Badge
  } = window.PowerDesignSystem_138199;
  const rows = [['sun', 'Solar', 'solar', '4.21', 'Producing'], ['battery-charging', 'Battery', 'battery', '1.12', 'Charging · 78%'], ['house', 'Home', 'home', '2.25', 'Consuming'], ['utility-pole', 'Grid', 'grid', '0.84', 'Exporting']];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(MHeader, {
    title: "Energy flow",
    sub: "Real-time power balance"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '0 16px 24px'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    accent: "solar",
    glow: true,
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement(EnergyFlow, {
    solar: DATA.live.solar,
    battery: DATA.live.battery,
    grid: DATA.live.grid,
    home: DATA.live.home
  })), /*#__PURE__*/React.createElement(Card, {
    title: "Now",
    style: {
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 13,
      padding: '15px 16px',
      borderTop: i ? '1px solid var(--border-1)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 38,
      height: 38,
      borderRadius: 10,
      display: 'grid',
      placeItems: 'center',
      background: 'var(--surface-3)',
      color: `var(--${r[2]})`
    }
  }, I(r[0], {
    width: 18,
    height: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14.5,
      fontWeight: 600
    }
  }, r[1]), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--text-2)'
    }
  }, r[4])), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 17,
      fontWeight: 500,
      color: `var(--${r[2]})`
    }
  }, r[3], /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--text-3)'
    }
  }, " kW"))))))));
}
function ChargeScreen() {
  const {
    Card,
    RadialGauge,
    ProgressBar,
    Button,
    Badge,
    Select,
    SegmentedControl
  } = window.PowerDesignSystem_138199;
  const [mode, setMode] = React.useState('Solar');
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(MHeader, {
    title: "EV charging",
    sub: "Wallbox \xB7 Garage",
    action: /*#__PURE__*/React.createElement(Badge, {
      tone: "ev",
      icon: I('zap', {
        width: 12,
        height: 12
      })
    }, "Charging")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '0 16px 24px'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    accent: "ev",
    glow: true,
    style: {
      padding: 22,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(RadialGauge, {
    value: 62,
    tone: "ev",
    label: "Charge",
    size: 170,
    thickness: 12
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 15,
      color: 'var(--text-1)'
    }
  }, "7.4 kW \xB7 28 km added"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-2)',
      marginTop: 2
    }
  }, "Full in 1h 45m \xB7 80% target")))), /*#__PURE__*/React.createElement(Card, {
    title: "Charge source",
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(SegmentedControl, {
    block: true,
    options: ['Solar', 'Cheap rate', 'Fast'],
    value: mode,
    onChange: setMode
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(ProgressBar, {
    height: 10,
    segments: [{
      value: 68,
      tone: 'solar'
    }, {
      value: 32,
      tone: 'grid'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: 8,
      fontSize: 12,
      color: 'var(--text-2)',
      fontFamily: 'var(--font-mono)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--solar)'
    }
  }, "68% solar"), /*#__PURE__*/React.createElement("span", null, "32% grid")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconLeft: I('zap'),
    block: true
  }, "Charge now"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    iconLeft: I('pause'),
    block: true
  }, "Pause"))));
}
function StatsScreen() {
  const {
    DATA
  } = window.PWRKit;
  const {
    Card,
    StatTile,
    ProgressBar,
    SegmentedControl
  } = window.PowerDesignSystem_138199;
  const {
    AreaChart
  } = window.PWRCharts;
  const [range, setRange] = React.useState('Day');
  const breakdown = [['EV charger', 'plug-zap', 'ev', 58.2, 38], ['Heat pump', 'thermometer', 'grid', 42.6, 28], ['Appliances', 'washing-machine', 'home', 28.1, 18], ['Water heater', 'droplet', 'battery', 15.3, 10]];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(MHeader, {
    title: "Statistics",
    sub: "Production & consumption"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '0 16px 24px'
    }
  }, /*#__PURE__*/React.createElement(SegmentedControl, {
    block: true,
    options: ['Day', 'Week', 'Month', 'Year'],
    value: range,
    onChange: setRange
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Produced",
    value: DATA.today.produced,
    unit: "kWh",
    tone: "solar",
    icon: I('sun'),
    delta: 12
  })), /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    size: "sm",
    label: "Saved",
    value: `€${DATA.today.savings}`,
    tone: "solar",
    icon: I('piggy-bank'),
    delta: 9
  }))), /*#__PURE__*/React.createElement(Card, {
    title: "Today \xB7 kW",
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(AreaChart, {
    height: 150,
    series: [{
      data: DATA.solarDay,
      tone: 'solar'
    }, {
      data: DATA.homeDay,
      tone: 'home',
      dash: true,
      fill: false
    }],
    labels: ['00', '08', '16', '24']
  })), /*#__PURE__*/React.createElement(Card, {
    title: "By device",
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, breakdown.map(b => /*#__PURE__*/React.createElement("div", {
    key: b[0],
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: `var(--${b[2]})`
    }
  }, I(b[1], {
    width: 16,
    height: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 14
    }
  }, b[0]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13
    }
  }, b[3], " kWh")), /*#__PURE__*/React.createElement(ProgressBar, {
    height: 6,
    segments: [{
      value: b[4],
      tone: b[2]
    }]
  })))))));
}
function PhoneApp() {
  const {
    drawIcons
  } = window.PWRKit;
  const [tab, setTab] = React.useState('home');
  React.useEffect(() => {
    drawIcons();
  });
  const tabs = [['home', 'Home', 'house'], ['flow', 'Flow', 'zap'], ['charge', 'Charge', 'plug-zap'], ['stats', 'Stats', 'bar-chart-3']];
  let Screen;
  if (tab === 'home') Screen = /*#__PURE__*/React.createElement(HomeScreen, null);else if (tab === 'flow') Screen = /*#__PURE__*/React.createElement(FlowScreen, null);else if (tab === 'charge') Screen = /*#__PURE__*/React.createElement(ChargeScreen, null);else Screen = /*#__PURE__*/React.createElement(StatsScreen, null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 28,
      background: 'radial-gradient(circle at 50% 0%, #0c1418, var(--bg-0))'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 390,
      height: 844,
      borderRadius: 46,
      background: 'var(--bg-0)',
      border: '10px solid #1a2227',
      boxShadow: '0 40px 90px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.04)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(StatusBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, Screen), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      padding: '10px 12px 22px',
      borderTop: '1px solid var(--border-1)',
      background: 'var(--glass-fill)',
      backdropFilter: 'blur(var(--blur-glass))'
    }
  }, tabs.map(t => {
    const on = tab === t[0];
    return /*#__PURE__*/React.createElement("button", {
      key: t[0],
      onClick: () => setTab(t[0]),
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: on ? 'var(--solar)' : 'var(--text-3)'
      }
    }, I(t[2], {
      width: 22,
      height: 22
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10.5,
        fontWeight: on ? 600 : 500
      }
    }, t[1]));
  }))));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(PhoneApp, null));
setTimeout(() => window.lucide && window.lucide.createIcons(), 80);
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/mobile/MobileApp.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.StatusDot = __ds_scope.StatusDot;

__ds_ns.EnergyFlow = __ds_scope.EnergyFlow;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.RadialGauge = __ds_scope.RadialGauge;

__ds_ns.Sparkline = __ds_scope.Sparkline;

__ds_ns.StatTile = __ds_scope.StatTile;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.SegmentedControl = __ds_scope.SegmentedControl;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.Switch = __ds_scope.Switch;

})();
