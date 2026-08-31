import { useEffect } from 'react';
import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';

export const PIN_LENGTH = 6;

interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired once the sixth digit lands — the caller submits. */
  onComplete?: (pin: string) => void;
  disabled?: boolean;
  /** Set on a rejected PIN to shake the dots. */
  shake?: boolean;
  /** Hide the on-screen keypad when the field sits inside a form. */
  keypad?: boolean;
  autoFocus?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Six-digit entry: dots plus a tap keypad, with the physical keyboard wired in. */
export function PinPad({
  value, onChange, onComplete, disabled, shake, keypad = true, autoFocus = true,
}: PinPadProps) {
  const push = (digit: string) => {
    if (disabled || value.length >= PIN_LENGTH) return;
    const next = value + digit;
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete?.(next);
  };

  const pop = () => {
    if (disabled) return;
    onChange(value.slice(0, -1));
  };

  // Typing works without a focused input, so the keypad never fights an on-screen
  // keyboard on mobile and still feels native on a desktop.
  useEffect(() => {
    if (!autoFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      // Never steal keystrokes from a focused field — the email box sits right
      // above the pad on a new device, and its digits belong to the email.
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); push(e.key); return; }
      if (e.key === 'Backspace') { e.preventDefault(); pop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="space-y-6">
      <div
        className={cn('flex justify-center gap-2.5', shake && 'animate-shake')}
        role="status"
        aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => {
          const filled = i < value.length;
          const active = i === value.length && !disabled;
          return (
            <span
              key={i}
              className={cn(
                'flex h-12 w-10 items-center justify-center rounded-xl border text-lg transition-all duration-150',
                filled
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border bg-elevated',
                active && 'border-accent/60 ring-2 ring-accent/25',
              )}
            >
              {filled && <span className="h-2.5 w-2.5 animate-pop-in rounded-full bg-accent" />}
            </span>
          );
        })}
      </div>

      {keypad && (
        <div className="mx-auto grid max-w-[15rem] grid-cols-3 gap-2.5">
          {KEYS.map(k => (
            <PinKey key={k} onClick={() => push(k)} disabled={disabled}>{k}</PinKey>
          ))}
          <span />
          <PinKey onClick={() => push('0')} disabled={disabled}>0</PinKey>
          <PinKey onClick={pop} disabled={disabled || !value} label="Delete last digit">
            <Delete className="h-5 w-5" />
          </PinKey>
        </div>
      )}
    </div>
  );
}

function PinKey({ children, onClick, disabled, label }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex h-14 items-center justify-center rounded-xl border border-border bg-elevated text-lg font-medium text-text-primary',
        'transition-all duration-100 hover:border-accent/50 hover:bg-accent/10 hover:text-accent',
        'active:scale-95 disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      {children}
    </button>
  );
}
