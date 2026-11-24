/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './docs/**/*.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#06090e',
        panel: '#0b1119',
        panelHead: '#0e1724',
      },
    },
  },
  plugins: [],
};
