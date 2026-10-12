// The two themes: "dark" (white on black, the default) and "light" (black on
// white). Colours live in app/theme.css; the switch is components/layout/ThemeToggle.

export type Theme = "dark" | "light";
export const THEME_KEY = "bb-theme";
/** The phone's status bar / browser bar colour for each theme. */
export const THEME_BAR: Record<Theme, string> = { dark: "#000000", light: "#ffffff" };

/**
 * Runs in <head> before anything is drawn: puts the theme this device chose on
 * <html>, so the page never flashes the other one.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");t=t==="light"?"light":"dark";document.documentElement.setAttribute("data-theme",t);var c=t==="light"?"${THEME_BAR.light}":"${THEME_BAR.dark}";var s=function(){document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",c)})};s();document.addEventListener("DOMContentLoaded",s)}catch(e){}})();`;
