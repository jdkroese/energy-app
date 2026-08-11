import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { useEditMode } from '../../lib/EditModeProvider';

/**
 * EditToggle — compact circular pencil button for the header, styled to match
 * ThemeToggle. Flips the page-scoped edit-mode flag (EditModeProvider) and
 * shows a pressed/accent look while on; individual screens opt into reacting
 * to `editMode` when they have editable content.
 */
export function EditToggle({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const { editMode, toggleEditMode } = useEditMode();
  return (
    <IconButton
      size={size}
      variant={editMode ? 'accent' : 'solid'}
      label={editMode ? 'Done editing' : 'Edit this page'}
      aria-pressed={editMode}
      className="pwr-iconbtn--circle"
      onClick={toggleEditMode}
    >
      <Icon name="pencil" />
    </IconButton>
  );
}
