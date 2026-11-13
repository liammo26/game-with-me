# Game With Me

A home-screen web app (PWA) for a group of friends. Tap the controller, it fills green, and your party gets a push notification that you're on. They answer with one tap ("On my way", "Will be 30", "Can't right now", or their own). A week-ahead planner shows who can play morning, afternoon or evening.

Works on Android (Chrome) and iPhone/iPad (Safari, iOS 16.4 or later, after Add to Home Screen).

## Try it right now

Open `index.html` in a browser. With `config.js` empty the app runs in **demo mode** with pretend friends, so you can click around before setting anything up. Nothing is saved and no real notifications are sent.

## What's in the folder

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app. Plain HTML/CSS/JS, no build step. |
| `config.js` | Your settings: Supabase address, keys, platform list. |
| `sw.js` | Service worker: receives pushes, shows notifications, offline fallback. |
| `manifest.webmanifest`, `icons/` | Makes it installable to the home screen. |
| `vendor/supabase.js` | Supabase client library (bundled, so no CDN is needed). |
| `supabase/schema.sql` | Database tables and security rules. |
| `supabase/functions/notify/index.ts` | The sender: decides who to notify and pushes to their phones. |
| `setup/vapid-keygen.html` | Makes your notification key pair in the browser. |

## Going live (about 20 minutes, all free tiers)

GitHub Pages hosts the app. Supabase stores accounts, parties and the calendar, and sends the notifications.

### 1. Create the Supabase project

1. Sign up at supabase.com and create a new project (any name, a region near you).
2. Open **SQL Editor**, start a new query, paste in all of `supabase/schema.sql`, and press **Run**.

### 2. Allow username sign-ups

Go to **Authentication > Sign In / Providers > Email** and switch **Confirm email** off, then save.

People sign in with a username and password. Supabase needs an email address behind the scenes, so the app invents one per user (`wg-<username>@users.noreply.github.com`). Nothing is ever sent to it, which is why confirmation has to be off.

### 3. Make your notification keys

1. Open `setup/vapid-keygen.html` in a browser and press **Generate keys**.
2. In Supabase go to **Edge Functions > Secrets** and add three secrets:
   - `VAPID_PUBLIC_KEY`: the public key
   - `VAPID_PRIVATE_KEY`: the private key
   - `VAPID_SUBJECT`: `mailto:` followed by your real email address (Apple rejects made-up ones)

Do this once. The private key never goes into GitHub.

### 4. Deploy the sender

1. In Supabase go to **Edge Functions > Deploy a new function > Via Editor**.
2. Name it exactly `notify`.
3. Replace the sample code with the contents of `supabase/functions/notify/index.ts` and deploy.
4. In the function's settings, turn **Verify JWT with legacy secret** off. The function checks who is calling by itself.

### 5. Fill in `config.js`

From **Project Settings > API Keys** (and **Data API** for the address) copy:

- `SUPABASE_URL`: the project URL, like `https://abcdefgh.supabase.co`
- `SUPABASE_KEY`: the publishable key (or the legacy `anon` key). This one is designed to be public.
- `VAPID_PUBLIC_KEY`: the public key from step 3

All three are safe to commit. The security rules in the database are what protect the data.

### 6. Publish on GitHub Pages

1. Create a repository and push this folder to it.
2. In the repository go to **Settings > Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`.
3. After a minute the app is at `https://<your-username>.github.io/<repo-name>/`.

### 7. Install it on phones

- **Android:** open the link in Chrome, sign up, then open the menu (top left) and go to **Settings > Add to home screen** and **Enable notifications**.
- **iPhone / iPad:** open the link in **Safari**, tap **Share > Add to Home Screen**, open the app from the new icon, sign up, then **menu > Settings > Enable notifications**. On iOS notifications only work from the home-screen icon, never from a Safari tab.

Press **Send me a test** in Settings to check everything end to end.

## How it works

- **The controller:** tap to go on (white fills to green). There is no sign-off: you stay "on" for one hour, the circle round the controller drains as the hour runs down, and then it clears itself. To change the length, edit `SESSION_MS` at the top of `app.js`.
- **Parties:** anyone can start a party and becomes its host. Friends join by invite link or code (instant), or by typing your exact username and asking to join (the host accepts). There is no browsing: you have to know the username.
- **Who sees what:** only people who share a party with you can see your username, controller, when you're on, your replies and your week. A host also sees the username of anyone asking to join. Nobody else can list users or parties.
- **What the database enforces:** check-ins and replies go through database functions that stamp the time themselves, so a double tap or a second phone cannot check in twice inside the hour, and replies only work on a party mate's current check-in. Each check-in and join request is announced once; a reply is announced when it changes, three times at most. A user can change only their own quick replies and controller colours, never their username.
- **Notifications go to:** your whole party when you go on, the person who's on when you reply, and the host when someone asks to join.
- **Menu:** the button at the top left slides in a menu with Stats, Trophies, Customise, Settings and Sign out. The bottom bar keeps the three everyday screens: Play, Week and Party.
- **Stats:** your check-ins, replies sent and received, best streak, slots planned, biggest turnout and favourite day and time, plus a leaderboard for each party (most check-ins, most replies, most popular day and time).
- **Trophies:** 16 milestones (10 check-ins, 10 replies, a 3-day streak, and so on). Each one unlocks a colour for your controller body, its buttons or the ring. Your party sees your controller next to your name. The list lives in `TROPHIES` at the top of `app.js` and the colours in `LOOKS`; add or change them freely. Trophy locks are enforced by the app only, not the database, so a determined friend could cheat.
- **Week ahead:** tap a slot to see who is in; tap it again, or use the button, to add or remove yourself. The number and colour show how many are in; "Best bets" lists the busiest slots.

## Updating an existing setup

Whenever `supabase/schema.sql` or `supabase/functions/notify/index.ts` changes, run the SQL file in the SQL Editor again and paste the function in again. The SQL is safe to re-run and keeps all existing data. The app and the database must match: an older database will refuse check-ins and replies from this version of the app.

## Changing things

- **Add Xbox, PC or Switch:** edit `PLATFORMS` in `config.js`, for example `['PlayStation', 'Xbox']`. A picker appears above the controller.
- **Default replies:** `DEFAULT_REPLIES` at the top of `app.js`.
- **After editing app files:** raise `BUILD` at the top of `app.js` by one. Settings shows it as "Version N", so you can tell which version a phone is running. Phones pick up new files the next time the app is opened, and an app left open shows a "New version ready" bar.

## Troubleshooting

- **"Email address is invalid" when signing up:** Supabase did not accept the invented email domain. Change `AUTH_EMAIL_DOMAIN` in `config.js` to a domain you own. Do this before anyone signs up, because changing it later breaks existing logins.
- **"Account made, but Confirm email is still switched on":** redo step 2.
- **Test notification says no device is subscribed:** press Enable notifications on that phone first. On iPhone, make sure you opened the app from the home-screen icon.
- **Test says sent but nothing arrives:** check **Edge Functions > notify > Logs**. A `403` from Apple usually means `VAPID_SUBJECT` is not a proper `mailto:` address, or the public key in `config.js` does not match the secret.
- **No password reset:** there is no real email on file. For now a forgotten password means a new username.

## Known limits and ideas for later

- Notifications cannot be answered from the lock screen yet; tapping one opens the app.
- No password reset (see above); adding an optional real email would fix it.
- Possible next steps: reminder push before a planned slot, per-party mute, "who's free tonight" nudge, Xbox/PSN presence lookups.
