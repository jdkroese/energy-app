import { useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { auth, ApiError } from '../../lib/api';
import { Button, Input } from '../../components/ui';
import { AuthShell, AuthError, AuthNote, HintRow } from './AuthShell';

const MIN = 10;

export function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const longEnough = password.length >= MIN;
  const matches = confirm.length > 0 && password === confirm;
  const valid = longEnough && matches;

  if (!token) {
    return (
      <AuthShell
        title="Invalid reset link"
        subtitle="This password-reset link is missing or malformed. Request a new one from the sign-in screen."
        footer={<Link to="/login" style={{ color: 'var(--solar)' }}>Go to sign in</Link>}
      >
        <span />
      </AuthShell>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await auth.reset(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 400 || err.status === 401 || err.status === 410)
          ? 'This reset link is invalid or has expired. Request a new one.'
          : 'Could not reset your password. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        subtitle="Your password has been changed."
        footer={<Link to="/login" style={{ color: 'var(--solar)' }}>Go to sign in</Link>}
      >
        <AuthNote tone="success">You can now sign in with your new password.</AuthNote>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Set a new password for your Power account.">
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <AuthError>{error}</AuthError>}
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          placeholder="At least 10 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Input
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: -2 }}>
          <HintRow ok={longEnough}>At least {MIN} characters</HintRow>
          <HintRow ok={matches}>Passwords match</HintRow>
        </div>
        <Button type="submit" block loading={busy} disabled={!valid}>
          Reset password
        </Button>
      </form>
    </AuthShell>
  );
}
