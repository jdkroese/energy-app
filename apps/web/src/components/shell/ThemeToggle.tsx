import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { useTheme } from '../../lib/ThemeProvider';

/**
 * ThemeToggle — compact sun/moon button for the header.
 *
 * Shows a sun when dark is painting (click → light) and a moon when light is
 * painting (click → dark). It's an explicit dark↔light flip; the Settings
 * control still offers System. Ghost style, token-driven, themeable.
 */
export function ThemeToggle({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const { resolved, setTheme } = useTheme();
  const toLight = resolved === 'dark';
  return (
    <IconButton
      size={size}
      variant="solid"
      label={toLight ? 'Switch to light theme' : 'Switch to dark theme'}
      className="pwr-iconbtn--circle"
      onClick={() => setTheme(toLight ? 'light' : 'dark')}
    >
      <Icon name={toLight ? 'sun' : 'moon'} />
    </IconButton>
  );
}
