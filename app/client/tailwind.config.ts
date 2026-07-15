import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0f1a',
        surface: '#151929',
        elevated: '#1c2135',
        border: '#2a3147',
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
          light: 'rgba(99,102,241,0.12)',
        },
        text: {
          primary: '#e2e8f0',
          muted: '#64748b',
          subtle: '#475569',
        },
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'spin-slow': 'spin 2s linear infinite',
        'fade-up': 'fadeUp 0.4s ease-out both',
        'pop-in': 'popIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'float': 'float 4s ease-in-out infinite',
        'broadcast': 'broadcast 2.4s ease-in-out infinite',
        'shimmer': 'shimmer 1.6s linear infinite',
        'glow-pulse': 'glowPulse 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        fadeUp: { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        popIn: { from: { opacity: '0', transform: 'scale(0.9)' }, to: { opacity: '1', transform: 'scale(1)' } },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-5px)' } },
        broadcast: { '0%, 100%': { opacity: '0.25', transform: 'scaleX(0.55)' }, '50%': { opacity: '1', transform: 'scaleX(1)' } },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
        glowPulse: { '0%, 100%': { opacity: '0.35' }, '50%': { opacity: '0.7' } },
      },
    },
  },
  plugins: [],
} satisfies Config;
