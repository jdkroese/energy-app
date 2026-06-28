/**
 * Ported Power design-system component CSS (verbatim from /Design system/components).
 * Injected once at module load. Keeps the primitives pixel-faithful to the DS
 * without shipping the DS's React-18 runtime bundle.
 */
const CSS = `
/* ---- Card ---- */
.pwr-card{ position:relative; display:flex; flex-direction:column;
  background:var(--surface-card); border:1px solid var(--border-1);
  border-radius:var(--radius-card); box-shadow:var(--shadow-2), var(--hairline-top); overflow:hidden; }
.pwr-card--pad{ padding:var(--space-5); }
.pwr-card--interactive{ cursor:pointer; transition:border-color var(--dur) var(--ease-out),
  transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out); }
.pwr-card--interactive:hover{ border-color:var(--border-3); transform:translateY(-2px);
  box-shadow:var(--shadow-card), var(--hairline-top); }
.pwr-card--glow{ box-shadow:var(--shadow-2), var(--glow-soft), var(--hairline-top); border-color:rgba(46,230,160,0.28); }
.pwr-card[data-accent]::before{ content:""; position:absolute; inset:0 0 auto 0; height:2px; background:var(--_rail, var(--accent)); opacity:0.9; }
.pwr-card[data-accent="solar"]{ --_rail:var(--solar); }
.pwr-card[data-accent="battery"]{ --_rail:var(--battery); }
.pwr-card[data-accent="grid"]{ --_rail:var(--grid); }
.pwr-card[data-accent="home"]{ --_rail:var(--home); }
.pwr-card[data-accent="ev"]{ --_rail:var(--ev); }
.pwr-card[data-accent="danger"]{ --_rail:var(--danger); }
.pwr-card__head{ display:flex; align-items:center; gap:var(--space-3); padding:var(--space-4) var(--space-5); border-bottom:1px solid var(--border-1); }
.pwr-card__title{ font-size:var(--fs-h4); font-weight:var(--fw-semibold); letter-spacing:var(--ls-heading); color:var(--text-1); margin:0; }
.pwr-card__sub{ font-size:var(--fs-xs); color:var(--text-2); margin:2px 0 0; }
.pwr-card__head-actions{ margin-left:auto; display:flex; align-items:center; gap:var(--space-1); }
.pwr-card__head-ic{ display:inline-flex; color:var(--text-2); }
.pwr-card__head-ic svg{ width:18px; height:18px; }
.pwr-card__body{ padding:var(--space-5); flex:1; }

/* ---- StatTile ---- */
.pwr-stat{ display:flex; flex-direction:column; gap:10px; min-width:0; }
.pwr-stat__top{ display:flex; align-items:center; gap:8px; }
.pwr-stat__icon{ display:inline-flex; width:26px; height:26px; align-items:center; justify-content:center;
  border-radius:var(--radius-sm); color:var(--_tone, var(--text-2)); background:var(--_wash, var(--surface-3)); }
.pwr-stat__icon svg{ width:15px; height:15px; }
.pwr-stat__label{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em; text-transform:uppercase; color:var(--text-2); }
.pwr-stat__value{ display:flex; align-items:baseline; gap:6px; font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  letter-spacing:var(--ls-mono); font-weight:var(--fw-medium); color:var(--_tone, var(--text-1)); line-height:1; }
.pwr-stat__num{ font-size:var(--fs-metric-lg); }
.pwr-stat--sm .pwr-stat__num{ font-size:var(--fs-metric-md); }
.pwr-stat--xl .pwr-stat__num{ font-size:var(--fs-metric-xl); }
.pwr-stat__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); font-weight:var(--fw-regular); }
.pwr-stat__foot{ display:flex; align-items:center; gap:6px; font-size:var(--fs-xs); color:var(--text-2); }
.pwr-stat__delta{ display:inline-flex; align-items:center; gap:3px; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:var(--fw-medium); }
.pwr-stat__delta svg{ width:12px; height:12px; }
.pwr-stat__delta--up{ color:var(--success); }
.pwr-stat__delta--down{ color:var(--danger); }
.pwr-stat__delta--flat{ color:var(--text-3); }

/* ---- RadialGauge ---- */
.pwr-gauge{ display:inline-grid; place-items:center; position:relative; }
.pwr-gauge svg{ display:block; transform:rotate(135deg); }
.pwr-gauge__arc{ transition:stroke-dashoffset var(--dur-slow) var(--ease-out); }
.pwr-gauge__center{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:2px; }
.pwr-gauge__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:var(--fw-medium); color:var(--text-1); line-height:1; }
.pwr-gauge__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); }
.pwr-gauge__cap{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em; text-transform:uppercase; color:var(--text-2); }

/* ---- ProgressBar ---- */
.pwr-bar{ display:flex; flex-direction:column; gap:6px; width:100%; }
.pwr-bar__top{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.pwr-bar__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-bar__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-bar__track{ position:relative; width:100%; background:var(--surface-4); border-radius:var(--radius-pill); overflow:hidden; }
.pwr-bar__fill{ height:100%; border-radius:var(--radius-pill); background:var(--_c, var(--accent)); transition:width var(--dur-slow) var(--ease-out); }
.pwr-bar--glow .pwr-bar__fill{ box-shadow:0 0 12px var(--_c, var(--accent)); }
.pwr-bar__seg{ height:100%; }
.pwr-bar__seg:first-child{ border-radius:var(--radius-pill) 0 0 var(--radius-pill); }
.pwr-bar__seg:last-child{ border-radius:0 var(--radius-pill) var(--radius-pill) 0; }

/* ---- Badge ---- */
.pwr-badge{ display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:var(--radius-pill);
  font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.02em; line-height:1; white-space:nowrap; border:1px solid transparent; }
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

/* ---- StatusDot ---- */
.pwr-status{ display:inline-flex; align-items:center; gap:7px; font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-medium); color:var(--text-2); white-space:nowrap; }
.pwr-status__dot{ position:relative; width:8px; height:8px; border-radius:50%; background:var(--_c, var(--text-3)); flex:none; }
.pwr-status[data-tone="solar"]{ --_c:var(--solar); }
.pwr-status[data-tone="battery"]{ --_c:var(--battery); }
.pwr-status[data-tone="grid"]{ --_c:var(--grid); }
.pwr-status[data-tone="home"]{ --_c:var(--home); }
.pwr-status[data-tone="danger"]{ --_c:var(--danger); }
.pwr-status[data-tone="offline"]{ --_c:var(--text-3); }
.pwr-status--live .pwr-status__dot::after{ content:""; position:absolute; inset:-3px; border-radius:50%; background:var(--_c); opacity:0.5; animation:pwr-pulse 1.8s var(--ease-out) infinite; }
@keyframes pwr-pulse{ 0%{ transform:scale(0.7); opacity:0.55; } 70%{ transform:scale(2.4); opacity:0; } 100%{ opacity:0; } }

/* ---- Button ---- */
.pwr-btn{ --_h: var(--control-md); display:inline-flex; align-items:center; justify-content:center; gap:8px; height:var(--_h); padding:0 16px;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-semibold); letter-spacing:var(--ls-heading); line-height:1; white-space:nowrap;
  border-radius:var(--radius-md); border:1px solid transparent; cursor:pointer; user-select:none; text-decoration:none;
  transition:background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
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
.pwr-btn__spin{ width:14px;height:14px;border-radius:50%; border:2px solid currentColor;border-right-color:transparent;animation:pwr-btn-spin .7s linear infinite; }
@keyframes pwr-btn-spin{ to{ transform:rotate(360deg); } }
.pwr-btn__ic{ display:inline-flex; }
.pwr-btn__ic svg{ width:1em;height:1em; }

/* ---- IconButton ---- */
.pwr-iconbtn{ --_s: var(--control-md); display:inline-flex; align-items:center; justify-content:center; width:var(--_s); height:var(--_s); padding:0;
  border-radius:var(--radius-md); border:1px solid transparent; background:transparent; color:var(--text-2); cursor:pointer;
  transition:background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
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

/* ---- Switch ---- */
.pwr-switch{ display:inline-flex; align-items:center; gap:10px; cursor:pointer; user-select:none; }
.pwr-switch input{ position:absolute; opacity:0; width:0; height:0; }
.pwr-switch__track{ position:relative; width:42px; height:24px; flex:none; background:var(--surface-4); border:1px solid var(--border-2); border-radius:var(--radius-pill);
  transition:background var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out); }
.pwr-switch__thumb{ position:absolute; top:50%; left:3px; width:16px; height:16px; border-radius:50%; background:var(--text-2); transform:translateY(-50%);
  transition:transform var(--dur) var(--ease-spring), background var(--dur) var(--ease-out); }
.pwr-switch input:checked + .pwr-switch__track{ background:var(--accent); border-color:transparent; box-shadow:var(--glow-soft); }
.pwr-switch input:checked + .pwr-switch__track .pwr-switch__thumb{ transform:translate(18px,-50%); background:var(--accent-contrast); }
.pwr-switch input:focus-visible + .pwr-switch__track{ box-shadow:var(--focus-ring); }
.pwr-switch input:disabled + .pwr-switch__track{ opacity:0.4; }
.pwr-switch:has(input:disabled){ cursor:not-allowed; }
.pwr-switch__label{ font-size:var(--fs-sm); color:var(--text-1); }

/* ---- Slider ---- */
.pwr-slider{ display:flex; flex-direction:column; gap:8px; width:100%; }
.pwr-slider__top{ display:flex; align-items:baseline; justify-content:space-between; }
.pwr-slider__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-slider__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-slider__input{ -webkit-appearance:none; appearance:none; width:100%; height:22px; background:transparent; cursor:pointer; margin:0; }
.pwr-slider__input::-webkit-slider-runnable-track{ height:6px; border-radius:var(--radius-pill); background:linear-gradient(to right, var(--accent) var(--_pct,50%), var(--surface-4) var(--_pct,50%)); }
.pwr-slider__input::-moz-range-track{ height:6px; border-radius:var(--radius-pill); background:var(--surface-4); }
.pwr-slider__input::-moz-range-progress{ height:6px; border-radius:var(--radius-pill); background:var(--accent); }
.pwr-slider__input::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:16px; height:16px; margin-top:-5px; border-radius:50%; background:#eafff6; border:3px solid var(--accent); box-shadow:var(--glow-soft); transition:transform var(--dur-fast) var(--ease-out); }
.pwr-slider__input::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#eafff6; border:3px solid var(--accent); box-shadow:var(--glow-soft); }
.pwr-slider__input:active::-webkit-slider-thumb{ transform:scale(1.18); }
.pwr-slider__input:focus-visible{ outline:none; }
.pwr-slider__input:focus-visible::-webkit-slider-thumb{ box-shadow:var(--focus-ring); }

/* ---- SegmentedControl ---- */
.pwr-seg{ display:inline-flex; padding:3px; gap:2px; background:var(--surface-2); border:1px solid var(--border-1); border-radius:var(--radius-md); }
.pwr-seg--block{ display:flex; width:100%; }
.pwr-seg__opt{ flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; height:30px; padding:0 14px; border:none; background:transparent; cursor:pointer;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); border-radius:var(--radius-sm); white-space:nowrap;
  transition:color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
.pwr-seg__opt:hover{ color:var(--text-1); }
.pwr-seg__opt[aria-selected="true"]{ background:var(--surface-4); color:var(--text-1); box-shadow:var(--shadow-1), var(--hairline-top); }
.pwr-seg__opt:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-seg__opt svg{ width:15px; height:15px; }
.pwr-seg--sm .pwr-seg__opt{ height:26px; padding:0 10px; font-size:var(--fs-xs); }

/* ---- Select ---- */
.pwr-select-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-select-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-select-wrap{ position:relative; display:flex; align-items:center; }
.pwr-select{ width:100%; height:var(--control-md); padding:0 38px 0 12px; background:var(--surface-2); color:var(--text-1); cursor:pointer;
  border:1px solid var(--border-2); border-radius:var(--radius-md); font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1; -webkit-appearance:none; appearance:none;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pwr-select:hover{ border-color:var(--border-3); }
.pwr-select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(46,230,160,0.18); }
.pwr-select:disabled{ opacity:0.5; cursor:not-allowed; }
.pwr-select__chev{ position:absolute; right:12px; display:inline-flex; color:var(--text-3); pointer-events:none; }
.pwr-select__chev svg{ width:16px; height:16px; }
.pwr-select option{ background:var(--surface-2); color:var(--text-1); }

/* ---- EnergyFlow (pwr2 two-battery) ---- */
.pwr2{ position:relative; width:100%; aspect-ratio:1.02/1; min-height:300px; font-family:var(--font-sans); }
.pwr2__svg{ position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.pwr2__base{ stroke:var(--border-2); stroke-width:1.2; fill:none; }
.pwr2__line{ fill:none; stroke-width:2.4; stroke-linecap:round; stroke-dasharray:5 6; animation:pwr2move .9s linear infinite; }
@keyframes pwr2move{ from{stroke-dashoffset:11;} to{stroke-dashoffset:0;} }
.pwr2__node{ position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:3px; width:88px; text-align:center; }
.pwr2__chip{ display:flex; align-items:center; justify-content:center; width:46px; height:46px; border-radius:14px;
  background:var(--surface-2); border:1px solid var(--border-2); color:var(--_c, var(--text-3)); box-shadow:var(--shadow-1), var(--hairline-top); transition:box-shadow .2s,border-color .2s,color .2s; }
.pwr2__chip svg{ width:20px; height:20px; }
.pwr2__node--active .pwr2__chip{ border-color:var(--_c); box-shadow:0 0 0 1px var(--_c), 0 0 16px color-mix(in srgb, var(--_c) 45%, transparent); }
.pwr2__name{ font-size:9px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-2); }
.pwr2__kw{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:13px; font-weight:500; color:var(--_c, var(--text-1)); line-height:1; }
.pwr2__kw small{ font-size:8px; color:var(--text-3); }
.pwr2__sub{ font-family:var(--font-mono); font-size:9px; color:var(--text-3); line-height:1.1; }
.pwr2__hub{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:52px; height:52px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; color:var(--accent);
  background:radial-gradient(circle at 50% 35%, var(--surface-3), var(--surface-1)); border:1px solid var(--border-3); box-shadow:var(--glow-soft, 0 0 20px rgba(46,230,160,.18)); }
.pwr2__hub svg{ width:22px; height:22px; }
.pwr2__hub::after{ content:""; position:absolute; inset:-6px; border-radius:50%; border:1px solid rgba(46,230,160,.25); animation:pwr2ring 2.6s ease-out infinite; }
@keyframes pwr2ring{ 0%{transform:scale(.85);opacity:.7;} 70%{transform:scale(1.5);opacity:0;} 100%{opacity:0;} }
.pwr2--lg{ aspect-ratio:1.08/1; min-height:360px; }
.pwr2--lg .pwr2__node{ width:104px; gap:4px; }
.pwr2--lg .pwr2__chip{ width:52px; height:52px; border-radius:16px; }
.pwr2--lg .pwr2__chip svg{ width:22px; height:22px; }
.pwr2--lg .pwr2__name{ font-size:10px; }
.pwr2--lg .pwr2__kw{ font-size:14px; }
.pwr2--lg .pwr2__kw small{ font-size:9px; }
.pwr2--lg .pwr2__sub{ font-size:10px; }
.pwr2--lg .pwr2__hub{ width:60px; height:60px; }
.pwr2--lg .pwr2__hub svg{ width:24px; height:24px; }

/* ---- Input ---- */
.pwr-input-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-input-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-input{ width:100%; height:var(--control-md); padding:0 12px; background:var(--surface-2); color:var(--text-1);
  border:1px solid var(--border-2); border-radius:var(--radius-md); font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1; -webkit-appearance:none; appearance:none;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pwr-input::placeholder{ color:var(--text-3); }
.pwr-input:hover{ border-color:var(--border-3); }
.pwr-input:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(46,230,160,0.18); }
.pwr-input:disabled{ opacity:0.5; cursor:not-allowed; }

/* tariff strip */
.tband{ display:flex; gap:2px; height:8px; margin-top:9px; border-radius:4px; overflow:hidden; }
.tband i{ flex:1; display:block; }

/* ---- OTP code input (mono, monospaced 6-digit) ---- */
.pwr-otp{ width:100%; height:var(--control-lg); text-align:center; background:var(--surface-2); color:var(--text-1);
  border:1px solid var(--border-2); border-radius:var(--radius-md); -webkit-appearance:none; appearance:none;
  font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:24px; font-weight:500; letter-spacing:0.5em; padding-left:0.5em;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pwr-otp::placeholder{ color:var(--text-3); letter-spacing:0.5em; }
.pwr-otp:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(46,230,160,0.18); }

/* ---- Auth splash pulse ---- */
.pwr-splash{ min-height:100dvh; display:grid; place-items:center; background:var(--bg-0); }
.pwr-splash__mark{ animation:pwr-splash-pulse 1.6s var(--ease-out) infinite; }
@keyframes pwr-splash-pulse{ 0%,100%{ opacity:0.45; transform:scale(0.97); } 50%{ opacity:1; transform:scale(1); } }

/* ---- Clickable grid-voltage tile (opens the 48h history overlay) ---- */
.pwr-voltage-tile{ transition:background-color var(--dur) var(--ease-out); }
.pwr-voltage-tile:hover{ background:var(--surface-2); }
.pwr-voltage-tile:hover .pwr-voltage-tile__chart{ opacity:1; color:var(--grid); }
.pwr-voltage-tile:focus-visible{ outline:2px solid var(--grid); outline-offset:2px; }
`;

let injected = false;
export function ensureDsStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'ds');
  s.textContent = CSS;
  document.head.appendChild(s);
}
