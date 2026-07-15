import { useId } from 'react';
import { cn } from '@/lib/utils';

interface LogoProps {
  /** Rendered pixel size (width = height). */
  size?: number;
  className?: string;
  /** Animate the broadcast arcs + a soft float. Used on the login screen. */
  animated?: boolean;
}

/**
 * LoStreamu brand mark — an indigo play badge with two "streaming" broadcast
 * arcs. Gradient id is scoped per instance (useId) so it can render more than
 * once on a page without clashing.
 */
export function Logo({ size = 28, className, animated = false }: LogoProps) {
  const gid = useId().replace(/:/g, '');

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label="LoStreamu"
      className={cn(animated && 'animate-float', className)}
    >
      <defs>
        <linearGradient id={`ls-${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8.5" fill={`url(#ls-${gid})`} />
      <path
        d="M12.5 11.3c0-.86.94-1.38 1.66-.92l6.2 3.9a1.1 1.1 0 0 1 0 1.86l-6.2 3.9c-.72.46-1.66-.06-1.66-.92z"
        fill="#fff"
      />
      <g fill="none" stroke="#fff" strokeLinecap="round">
        <path
          d="M22.2 12.4a5 5 0 0 1 0 7.2"
          strokeWidth="1.6"
          className={cn(animated && 'animate-broadcast origin-left')}
        />
        <path
          d="M24.7 9.8a8.6 8.6 0 0 1 0 12.4"
          strokeWidth="1.6"
          strokeOpacity="0.55"
          className={cn(animated && 'animate-broadcast [animation-delay:0.4s] origin-left')}
        />
      </g>
    </svg>
  );
}
