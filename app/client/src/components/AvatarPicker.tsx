import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AVATAR_KEYS, avatarGradient, type AvatarKey } from '@/lib/avatars';

interface AvatarPickerProps {
  value: AvatarKey;
  onChange: (key: AvatarKey) => void;
  className?: string;
}

/** Row of gradient swatches — the profile's colour identity. */
export function AvatarPicker({ value, onChange, className }: AvatarPickerProps) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {AVATAR_KEYS.map(key => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-label={`${key} tile`}
          aria-pressed={value === key}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150',
            'hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            value === key && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
          )}
          style={{ background: avatarGradient(key) }}
        >
          {value === key && <Check className="h-4 w-4 text-white drop-shadow" />}
        </button>
      ))}
    </div>
  );
}
