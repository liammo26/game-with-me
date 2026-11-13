// Game With Me - settings. Fill these in after following README.md.
// While SUPABASE_URL is empty the app runs in DEMO MODE with pretend friends.
window.WG_CONFIG = {
  SUPABASE_URL: 'https://wqohnccqhwtelkqditje.supabase.co',        // e.g. https://abcdefgh.supabase.co
  SUPABASE_KEY: 'sb_publishable_z3WqFhdpOtB3CXXbC770IQ_ZuYAcE5w',        // the "publishable" (or legacy "anon") key - safe to commit
  VAPID_PUBLIC_KEY: 'BBJRcJavOzkPQrqSylL0Bej_3RZwWSqv4nmKxwLN593aUwYYfiFWseRz6-_1Nl6r1_sa_4HVdc6s2HpD5mb-cek',    // public key from setup/vapid-keygen.html - safe to commit

  // Platforms offered on the "I'm on" button. Add 'Xbox', 'PC', 'Switch' any time.
  PLATFORMS: ['PlayStation'],

  // Supabase logins need an email behind the scenes. Usernames become
  // wg-<username>@<this domain>. Nothing is ever emailed. Don't change this
  // once people have signed up or their logins stop working.
  AUTH_EMAIL_DOMAIN: 'users.noreply.github.com'
};
