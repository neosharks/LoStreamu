// Profile tiles for the login picker. The keys are the contract with the server
// (src/services/users.ts AVATAR_KEYS); the gradients live here so the look can
// change without touching the API.
export const AVATAR_KEYS = [
  'indigo', 'violet', 'rose', 'amber', 'emerald', 'sky', 'slate', 'fuchsia',
] as const;

export type AvatarKey = typeof AVATAR_KEYS[number];

const GRADIENTS: Record<AvatarKey, string> = {
  indigo: 'linear-gradient(140deg, #818cf8, #4338ca)',
  violet: 'linear-gradient(140deg, #c4b5fd, #6d28d9)',
  rose: 'linear-gradient(140deg, #fda4af, #be123c)',
  amber: 'linear-gradient(140deg, #fcd34d, #b45309)',
  emerald: 'linear-gradient(140deg, #6ee7b7, #047857)',
  sky: 'linear-gradient(140deg, #7dd3fc, #0369a1)',
  slate: 'linear-gradient(140deg, #94a3b8, #334155)',
  fuchsia: 'linear-gradient(140deg, #f0abfc, #a21caf)',
};

export function avatarGradient(key: string | undefined): string {
  return GRADIENTS[(key as AvatarKey)] ?? GRADIENTS.indigo;
}

/** Up to two letters — "Ada Lovelace" → "AL", "ada" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
