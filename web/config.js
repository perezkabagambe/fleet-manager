// Public, non-secret configuration. The two __PLACEHOLDERS__ are replaced by the
// GitHub Actions deploy workflow with the real commit and build time.
window.FLEET_CONFIG = {
  // Apps Script web app URL (public; every call is still authorised server-side).
  apiUrl: '',
  // Must match API_VERSION in backend/Code.js.
  apiVersion: 1,
  commit: '__COMMIT__',
  builtAt: '__BUILT_AT__',
};
