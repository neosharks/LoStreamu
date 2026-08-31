import * as React from 'react';
import { Input } from './ui/input';
import { cn } from '@/lib/utils';
import { PIN_LENGTH } from './PinPad';

interface PinFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/** Masked 6-digit field for forms, where the tap keypad would be overkill. */
export function PinField({ value, onChange, placeholder = '••••••', className, disabled }: PinFieldProps) {
  return (
    <Input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      maxLength={PIN_LENGTH}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
      // Wide tracking suits six digits but mangles a word placeholder, so the
      // placeholder keeps normal spacing.
      className={cn('text-center font-mono tracking-[0.4em] placeholder:font-sans placeholder:tracking-normal', className)}
    />
  );
}
