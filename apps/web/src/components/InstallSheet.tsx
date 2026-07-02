import { useEffect, useState, type ReactNode } from 'react';
import { Icon, Button } from './ui';
import { detectInstall, promptInstall, type InstallPlatform } from '../lib/install';

/** A single numbered instruction with a recognition glyph on the right. */
function Step({ n, glyph, children }: { n: number; glyph: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <span
        style={{
          width: 26, height: 26, flex: 'none', borderRadius: 999,
          background: 'var(--surface-3)', color: 'var(--text-2)',
          display: 'grid', placeItems: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600,
        }}
      >
        {n}
      </span>
      <div style={{ flex: 1, fontSize: 14, lineHeight: 1.5, color: 'var(--text-1)' }}>{children}</div>
      <span
        style={{
          width: 34, height: 34, flex: 'none', borderRadius: 9,
          background: 'var(--surface-3)', color: 'var(--solar)',
          display: 'grid', placeItems: 'center',
        }}
      >
        <Icon name={glyph} size={18} />
      </span>
    </div>
  );
}

function Em({ children }: { children: ReactNode }) {
  return <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{children}</span>;
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 18px 18px' };
const note: React.CSSProperties = {
  fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)',
  background: 'var(--surface-2)', border: '1px solid var(--border-1)',
  borderRadius: 10, padding: '10px 12px',
};

function meta(platform: InstallPlatform): { title: string; subtitle: string } {
  switch (platform) {
    case 'standalone':
      return { title: "You're all set", subtitle: 'Home is installed on this device.' };
    case 'ios-safari':
      return { title: 'Add to Home Screen', subtitle: 'Install Home on your iPhone for a full-screen app with push notifications.' };
    case 'ios-other':
      return { title: 'Open in Safari to install', subtitle: 'On iPhone, Add to Home Screen only works from Safari.' };
    case 'chromium-prompt':
      return { title: 'Install Home', subtitle: 'Add Home as an app for a full-screen, one-tap experience.' };
    case 'chromium-manual':
      return { title: 'Install Home', subtitle: 'Add Home as an app from your browser menu.' };
    default:
      return { title: 'Add to Home Screen', subtitle: 'Install Home for a full-screen app experience.' };
  }
}

function Body({ platform, onClose }: { platform: InstallPlatform; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  if (platform === 'standalone') {
    return (
      <div style={{ ...wrap, alignItems: 'center', textAlign: 'center', paddingTop: 8 }}>
        <span style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--solar-wash)', color: 'var(--solar)', display: 'grid', placeItems: 'center' }}>
          <Icon name="check" size={28} />
        </span>
        <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.5 }}>
          You're running the installed app — launch Home any time from your Home Screen.
        </div>
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    );
  }

  if (platform === 'ios-safari') {
    return (
      <div style={wrap}>
        <Step n={1} glyph="square-arrow-up">
          Tap the <Em>Share</Em> button in Safari's toolbar
        </Step>
        <Step n={2} glyph="square-plus">
          Scroll down and choose <Em>Add to Home Screen</Em>
        </Step>
        <Step n={3} glyph="check">
          Tap <Em>Add</Em> — Home installs like a native app
        </Step>
        <div style={note}>
          Tip: open Home from its new Home Screen icon to get full-screen mode and enable push notifications.
        </div>
      </div>
    );
  }

  if (platform === 'ios-other') {
    return (
      <div style={wrap}>
        <Step n={1} glyph="compass">
          Open <Em>home.hirobo.nl</Em> in <Em>Safari</Em>
        </Step>
        <Step n={2} glyph="square-arrow-up">
          Tap the <Em>Share</Em> button
        </Step>
        <Step n={3} glyph="square-plus">
          Choose <Em>Add to Home Screen</Em>, then <Em>Add</Em>
        </Step>
        <div style={note}>iOS only allows Add to Home Screen from Safari — other browsers can't install it.</div>
      </div>
    );
  }

  if (platform === 'chromium-prompt') {
    return (
      <div style={{ ...wrap, gap: 12 }}>
        <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Home runs in its own window with no browser chrome, and stays one tap away.
        </div>
        <Button
          variant="primary"
          loading={busy}
          iconLeft={<Icon name="download" />}
          onClick={async () => {
            setBusy(true);
            const r = await promptInstall();
            setBusy(false);
            if (r !== 'unavailable') onClose();
          }}
        >
          Install Home
        </Button>
      </div>
    );
  }

  // chromium-manual / unsupported
  return (
    <div style={wrap}>
      <Step n={1} glyph="ellipsis-vertical">
        Open your browser's <Em>menu</Em> (⋮)
      </Step>
      <Step n={2} glyph="monitor-down">
        Choose <Em>Install app</Em> or <Em>Add to Home screen</Em>
      </Step>
      <div style={note}>
        If you don't see the option, your browser may not support installing web apps. Chrome, Edge, or Safari (iPhone) work best.
      </div>
    </div>
  );
}

/** Modal sheet that guides the user to install Home on the current platform. */
export function InstallSheet({ onClose }: { onClose: () => void }) {
  // Detect once on mount so the content can't flip mid-interaction.
  const [platform] = useState<InstallPlatform>(detectInstall);
  const { title, subtitle } = meta(platform);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,.62)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        animation: 'installFade var(--dur) var(--ease-out)',
      }}
    >
      <style>{`
        @keyframes installFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes installRise { from { transform: translateY(16px); opacity: .6 } to { transform: translateY(0); opacity: 1 } }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, margin: '0 10px 10px',
          background: 'var(--surface-1, #14181d)',
          border: '1px solid var(--border-2)', borderRadius: 18,
          boxShadow: '0 -8px 40px rgba(0,0,0,.5)',
          animation: 'installRise var(--dur) var(--ease-out)',
          maxHeight: '88vh', overflowY: 'auto',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px 10px' }}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--solar-wash)', color: 'var(--solar)', display: 'grid', placeItems: 'center' }}>
            <Icon name="smartphone" size={20} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.4, marginTop: 2 }}>{subtitle}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, flex: 'none', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-2)', cursor: 'pointer' }}
          >
            <Icon name="x" size={17} />
          </button>
        </div>

        <Body platform={platform} onClose={onClose} />
      </div>
    </div>
  );
}
