// Every colour the app uses points at a CSS variable (app/theme.css), so the
// whole app switches between the white-on-black and black-on-white themes by
// changing one attribute on <html> - no per-screen theme code.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const themed = (name) => Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));

module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}", "./lib/**/*.{js,ts}"],
  theme: {
    extend: {
      colors: {
        slate: themed("slate"),
        red: themed("red"),
        amber: themed("amber"),
        blue: themed("blue"),
        green: themed("green"),
        sky: themed("sky"),
        yellow: themed("yellow"),
        // "white" is the strongest text colour: white on the black theme,
        // black on the white theme. `paper` stays white in both (QR code).
        white: "rgb(var(--white) / <alpha-value>)",
        paper: "#ffffff",
      },
    },
  },
  plugins: [],
};
