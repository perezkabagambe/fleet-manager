# Fleet Manager Android app (APK)

The APK is a Trusted Web Activity: a thin Android wrapper that opens the live site
(https://perezkabagambe.github.io/fleet-manager/) full screen in Chrome. Changes to the web app reach everyone's phone
straight away; the APK only needs rebuilding to change its name, icon, colours or package id.

- `twa-manifest.json` describes the app (copied from the build folder `~/FleetManagerAndroid`).
- The signing key lives OUTSIDE this repository in `~/FleetManagerKeys/` (keystore + password file). Never commit it, and keep a
  backup: if it is lost nobody can update the installed app, everyone has to uninstall and reinstall.
- Android only trusts the app to open full screen because of https://perezkabagambe.github.io/.well-known/assetlinks.json,
  published from the repository `perezkabagambe/perezkabagambe.github.io`. It holds the signing certificate's public SHA-256
  fingerprint (FA:81:5F:B5:...:6E:63). If the key is ever replaced, that file must be updated to match.

## Rebuild

Tools (one-off): Java 17 and the Android SDK (build-tools 36.1.0) in `~/.bubblewrap`, set in `~/.bubblewrap/config.json`.

```bash
cd ~/FleetManagerAndroid            # the folder holding twa-manifest.json and the generated Android project
export BUBBLEWRAP_KEYSTORE_PASSWORD="$(cat ~/FleetManagerKeys/keystore-password.txt)"
export BUBBLEWRAP_KEY_PASSWORD="$BUBBLEWRAP_KEYSTORE_PASSWORD"
# after editing twa-manifest.json (and raising appVersionCode by 1 for a release people will update to):
npx @bubblewrap/cli update --skipVersionUpgrade
npx @bubblewrap/cli build --skipPwaValidation      # writes app-release-signed.apk
```

Minimum Android version is 7.0 (API 24), which the browser helper library requires.
