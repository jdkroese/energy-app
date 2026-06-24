// One-time "Add to home screen" hint for iOS Safari (which has no install prompt).
// Vanilla, framework-agnostic — adapt to a React component if preferred (see README).
// Shows a dismissible bar only when: iOS + Safari + not already installed + not dismissed.
(function () {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const dismissed = localStorage.getItem('pwr-a2hs-dismissed') === '1';
  if (!isIOS || isStandalone || dismissed) return;

  const bar = document.createElement('div');
  bar.setAttribute('role', 'note');
  bar.style.cssText = [
    'position:fixed', 'left:12px', 'right:12px',
    'bottom:calc(12px + env(safe-area-inset-bottom))', 'z-index:9999',
    'display:flex', 'align-items:center', 'gap:12px', 'padding:12px 14px',
    'border-radius:14px', 'background:rgba(20,29,33,.92)', '-webkit-backdrop-filter:blur(18px)',
    'backdrop-filter:blur(18px)', 'border:1px solid rgba(233,245,242,.14)',
    'color:#E9F5F2', 'font-family:system-ui,sans-serif', 'font-size:13px', 'line-height:1.4',
    'box-shadow:0 10px 30px rgba(0,0,0,.5)',
  ].join(';');
  bar.innerHTML =
    '<span style="font-size:20px">⚡</span>' +
    '<span style="flex:1">Install Power: tap <b>Share</b> then <b>Add to Home Screen</b>.</span>' +
    '<button aria-label="Dismiss" style="background:none;border:none;color:#9BB0AD;font-size:18px;cursor:pointer;padding:4px">×</button>';
  bar.querySelector('button').onclick = () => {
    localStorage.setItem('pwr-a2hs-dismissed', '1');
    bar.remove();
  };
  document.body.appendChild(bar);
})();
