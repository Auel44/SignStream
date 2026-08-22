/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        signstream: {
          DEFAULT: "#1f4e6b",
          dark: "#16384d",
          accent: "#2a9d8f",
        },
      },
    },
  },
  plugins: [],
};
