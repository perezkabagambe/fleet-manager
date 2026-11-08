// Public, non-secret configuration. The two __PLACEHOLDERS__ are replaced by the
// GitHub Actions deploy workflow with the real commit and build time.
window.FLEET_CONFIG = {
  // Apps Script web app URL (public; every call is still authorised server-side).
  apiUrl: 'https://script.google.com/macros/s/AKfycbxbuQjdH0mp_gvXY8-u1-Xtu1dpKnLRHqbB8O0SPcX6KD0eko6XD7TiBIx0Pe8-mGV0tQ/exec',
  // Public address of the app (used inside QR codes).
  siteUrl: 'https://perezkabagambe.github.io/fleet-manager/',
  // Google OAuth client ID for "Sign in with Google" (public by design). Empty = button hidden.
  googleClientId: '',
  // Must match API_VERSION in backend/Code.js.
  apiVersion: 1,
  commit: '__COMMIT__',
  builtAt: '__BUILT_AT__',
};
