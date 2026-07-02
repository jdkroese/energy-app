import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, ApiError } from '../../lib/api';
import type { OtpChannel } from '../../lib/types';
import { Button, Input, Switch } from '../../components/ui';
import { useAuth } from '../../auth/AuthProvider';
import { AuthShell, AuthError, AuthNote } from './AuthShell';

type View = 'login' | 'otp' | 'forgot';

const channelLabel: Record<OtpChannel, string> = { whatsapp: 'WhatsApp', email: 'email' };

export function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [view, setView] = useState<View>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OTP state
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [otpChannel, setOtpChannel] = useState<OtpChannel>('whatsapp');

  // Forgot-password state
  const [resetSent, setResetSent] = useState(false);

  const finish = async () => {
    await refresh();
    navigate('/', { replace: true });
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await auth.login(email.trim(), password);
      if ('step' in res && res.step === 'otp') {
        setOtpChannel(res.channel);
        setCode('');
        setView('otp');
      } else {
        await finish();
      }
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Invalid email or password.' : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.verifyOtp(email.trim(), code.trim(), trustDevice);
      await finish();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That code is incorrect or has expired.' : 'Could not verify the code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onForgot = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.requestReset(email.trim());
      setResetSent(true);
    } catch {
      // request-reset always returns ok; treat any failure as sent to avoid account enumeration
      setResetSent(true);
    } finally {
      setBusy(false);
    }
  };

  // ---- OTP view ----
  if (view === 'otp') {
    return (
      <AuthShell
        title="Enter your code"
        subtitle={
          <>We sent a 6-digit code to your {channelLabel[otpChannel]}.</>
        }
        footer={
          <button type="button" onClick={() => { setView('login'); setError(null); }} style={linkBtn}>
            Back to sign in
          </button>
        }
      >
        <form onSubmit={onVerify} style={col}>
          {error && <AuthError>{error}</AuthError>}
          <input
            className="pwr-otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            autoFocus
            placeholder="••••••"
            aria-label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Switch
            label="Trust this device for 60 days"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
          />
          <Button type="submit" block loading={busy} disabled={code.length !== 6}>
            Verify
          </Button>
          <p style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            Codes can take a moment to arrive. Check your {channelLabel[otpChannel]}.
          </p>
        </form>
      </AuthShell>
    );
  }

  // ---- Forgot view ----
  if (view === 'forgot') {
    return (
      <AuthShell
        title="Reset your password"
        subtitle="We'll send a reset code to the contact on file."
        footer={
          <button type="button" onClick={() => { setView('login'); setError(null); setResetSent(false); }} style={linkBtn}>
            Back to sign in
          </button>
        }
      >
        {resetSent ? (
          <AuthNote tone="success">
            If that account exists, we've sent a reset code to your WhatsApp or email.
          </AuthNote>
        ) : (
          <form onSubmit={onForgot} style={col}>
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" block loading={busy} disabled={!email.trim()}>
              Send reset code
            </Button>
          </form>
        )}
      </AuthShell>
    );
  }

  // ---- Login view ----
  return (
    <AuthShell title="Sign in to Home" subtitle="Your home energy control room.">
      <form onSubmit={onLogin} style={col}>
        {error && <AuthError>{error}</AuthError>}
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" block loading={busy} disabled={!email.trim() || !password}>
          Sign in
        </Button>
        <button type="button" onClick={() => { setView('forgot'); setError(null); setResetSent(false); }} style={{ ...linkBtn, alignSelf: 'center' }}>
          Forgot password?
        </button>
      </form>
    </AuthShell>
  );
}

const col = { display: 'flex', flexDirection: 'column' as const, gap: 14 };
const linkBtn = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--solar)',
  fontSize: 12.5,
  fontFamily: 'inherit',
};
