import { cn } from '@/lib/utils';
import { avatarGradient, initials } from '@/lib/avatars';

interface ProfileAvatarProps {
  name: string;
  avatar?: string;
  /** Tile edge in px. */
  size?: number;
  className?: string;
}

/** Gradient tile with the profile's initials — the visual identity of a user. */
export function ProfileAvatar({ name, avatar, size = 96, className }: ProfileAvatarProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-2xl font-semibold text-white/95 select-none',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: avatarGradient(avatar),
        fontSize: Math.round(size * 0.34),
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
      }}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}
