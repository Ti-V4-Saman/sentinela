/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#06110f',
          surface: '#0a1916',
          card: '#0f2420',
          hover: '#142d28',
          border: '#1a3a33',
          input: '#0b1d19',
        },
        brand: {
          emerald: '#00c885',
          emeraldDark: '#00a36c',
          emeraldLight: '#1ad193',
          glow: 'rgba(0, 200, 133, 0.25)',
        },
        danger: {
          DEFAULT: '#dc2626',
          hover: '#b91c1c',
          bg: '#3f1215',
          border: '#7f1d1d'
        }
      },
      fontFamily: {
        sans: ['Inter', 'Outfit', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
