import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { auth, ApiError } from '../../lib/api';
import { Button, Input } from '../../components/ui';
import { useAuth } from '../../auth/AuthProvider';
import { AuthShell, AuthError, HintRow } from './AuthShell';

const MIN = 10;

export function Setup() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const longEnough = password.length >= MIN;
  const matches = confirm.length > 0 && password === confirm;
  const valid = longEnough && matches;

  if (!token) {
    return (
      <AuthShell
        title="Invalid setup link"
        subtitle="This account-setup link is missing or malformed. Ask your administrator to send a new invitation."
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
      await auth.setup(token, password, name.trim() || undefined);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 400 || err.status === 401 || err.status === 410)
          ? 'This setup link is invalid or has expired. Ask your administrator for a new one.'
          : 'Could not create your account. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Set your password" subtitle="Choose a password to finish setting up your Power account.">
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <AuthError>{error}</AuthError>}
        <Input
          label="Your name (optional)"
          type="text"
          autoComplete="name"
          placeholder="Joris Kroese"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Password"
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
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
