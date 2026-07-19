// Firebase project configuration.
//
// This app works fully offline with no account — progress is kept in
// localStorage as before. Google sign-in, cloud-saved progress and the
// leaderboard are OPTIONAL and only turn on once you fill this in with your own
// Firebase web-app config (see the README section "Accounts, saved progress &
// leaderboards" for the 5-minute setup).
//
// These values are NOT secrets — a Firebase web config is meant to ship in the
// client. Access is controlled by the Firestore security rules, not by hiding
// this object. So it is safe to commit real values here for a public site.
//
// Leave the placeholders as-is to keep the app in pure offline (localStorage)
// mode: the sign-in button then shows a short "not configured" note and nothing
// tries to reach the network.

export const firebaseConfig = {
  apiKey: 'AIzaSyDxF351qIL8cd_gxPgTsVKOXCg2A8_hI3Q',
  authDomain: 'cantilator.firebaseapp.com',
  projectId: 'cantilator',
  storageBucket: 'cantilator.firebasestorage.app',
  messagingSenderId: '804773761826',
  appId: '1:804773761826:web:5a1a239c6251c4e5338b7b',
  measurementId: 'G-RHFNLRJH9H',
};

// Pin the Firebase JS SDK version loaded from the CDN (gstatic) at runtime.
// Bump this to adopt a newer SDK.
export const FIREBASE_SDK_VERSION = '10.12.2';

// True once the config has been filled in with real values (i.e. it no longer
// contains the shipped placeholders). When false, the app stays 100% offline.
export function isConfigured() {
  const v = firebaseConfig;
  return Boolean(
    v &&
    v.apiKey && !v.apiKey.startsWith('YOUR_') &&
    v.projectId && !v.projectId.startsWith('YOUR_') &&
    v.appId && !v.appId.startsWith('YOUR_')
  );
}
