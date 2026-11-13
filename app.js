/* Game With Me - app logic. No build step: plain JavaScript, edit and refresh. */
(() => {
'use strict';

const CFG = window.WG_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL;
const PLATFORMS = (CFG.PLATFORMS && CFG.PLATFORMS.length) ? CFG.PLATFORMS : ['PlayStation'];
const DEFAULT_REPLIES = ['On my way', 'Will be 30', "Can't right now"];
const SLOTS = [['am', 'AM', 'morning'], ['pm', 'PM', 'afternoon'], ['eve', 'Eve', 'evening']];
const SESSION_MS = 60 * 60 * 1000;   // an "I'm on" status clears itself after one hour
const RING = 2 * Math.PI * 47;       // length of the circle drawn round the controller
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/* ---------- controller looks and the trophies that unlock them ---------- */
// Each look is [label, colour]. The first in each group is the free default.
const LOOKS = {
  body: { green: ['Green', '#2bd576'], ice: ['Ice', '#5ac8fa'], sunrise: ['Sunrise', '#ff9f43'], midnight: ['Midnight', '#6d6ff5'],
    crimson: ['Crimson', '#ff4d5e'], purple: ['Royal', '#a06bff'], gold: ['Gold', '#f5c542'], prism: ['Prism', 'prism'] },
  buttons: { dark: ['Classic', '#0d1017'], white: ['White', '#ffffff'], cyan: ['Cyan', '#22d3ee'], pink: ['Hot pink', '#ff5fa2'],
    arcade: ['Arcade', 'arcade'], gold: ['Gold', '#f5c542'] },
  ring: { green: ['Green', '#2bd576'], cyan: ['Cyan', '#22d3ee'], flame: ['Flame', '#ff7a1a'], violet: ['Violet', '#c084fc'], gold: ['Gold', '#f5c542'] }
};
const DEFAULT_LOOK = { body: 'green', buttons: 'dark', ring: 'green' };
// [id, name, how to earn it, which stat counts, target, part it unlocks, look it unlocks]
const TROPHIES = [
  ['first', 'Player One', 'Check in for the first time', 'checkins', 1, 'body', 'ice'],
  ['early', 'Early Bird', 'Check in between 4am and 9am', 'early', 1, 'body', 'sunrise'],
  ['night', 'Night Owl', 'Check in between 11pm and 4am', 'night', 1, 'body', 'midnight'],
  ['regular', 'Regular', 'Check in 10 times', 'checkins', 10, 'body', 'crimson'],
  ['veteran', 'Veteran', 'Check in 25 times', 'checkins', 25, 'body', 'purple'],
  ['legend', 'Legend', 'Check in 50 times', 'checkins', 50, 'body', 'gold'],
  ['centurion', 'Centurion', 'Check in 100 times', 'checkins', 100, 'body', 'prism'],
  ['mate', 'Good Mate', 'Reply to a check-in', 'replies', 1, 'buttons', 'white'],
  ['crowd', 'Crowd Puller', 'Get 10 replies to your check-ins', 'received', 10, 'buttons', 'cyan'],
  ['reliable', 'Reliable', 'Reply 10 times', 'replies', 10, 'buttons', 'pink'],
  ['wingman', 'Wingman', 'Reply 25 times', 'replies', 25, 'buttons', 'arcade'],
  ['always', 'Always There', 'Reply 50 times', 'replies', 50, 'buttons', 'gold'],
  ['planner', 'Planner', 'Plan 10 different slots in the week ahead', 'planned', 10, 'ring', 'cyan'],
  ['roll', 'On a Roll', 'Check in 3 days running', 'streak', 3, 'ring', 'flame'],
  ['weekend', 'Weekend Warrior', 'Check in 5 times at a weekend', 'weekend', 5, 'ring', 'violet'],
  ['squad', 'Squad Assembled', 'Get 3 replies to one check-in', 'rally', 3, 'ring', 'gold']
].map(([id, name, desc, stat, goal, part, look]) => ({ id, name, desc, stat, goal, part, look }));
const NO_STATS = { checkins: 0, early: 0, night: 0, weekend: 0, streak: 0, replies: 0, received: 0, rally: 0, planned: 0 };
const lookOf = (c) => {
  const out = { ...DEFAULT_LOOK };
  Object.keys(out).forEach((part) => { if (c && LOOKS[part][c[part]]) out[part] = c[part]; });
  return out;
};
const CUP = '<svg viewBox="0 0 24 24"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initial = (name) => esc((name || '?').charAt(0).toUpperCase());
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } }
};

// Messages queue up and show one after another, so none is lost when two arrive together.
const toastQueue = [];
let toastBusy = false;
function toast(msg) {
  if (toastQueue[toastQueue.length - 1] === msg) return;
  toastQueue.push(msg);
  if (!toastBusy) nextToast();
}
function nextToast() {
  const el = $('#toast');
  const msg = toastQueue.shift();
  if (msg === undefined) { toastBusy = false; return; }
  toastBusy = true;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => { el.classList.remove('show'); setTimeout(nextToast, 250); }, toastQueue.length ? 1800 : 3200);
}

// "Will be 30" -> "≈ 20:15", worked out from when the reply was sent.
function eta(text, sentAt) {
  const m = String(text).match(/\b(\d{1,3})\b/);
  if (!m) return '';
  const mins = Number(m[1]);
  if (!mins || mins > 240) return '';
  return ` · ≈ ${clock(new Date(sentAt).getTime() + mins * 60000)}`;
}

function b64ToBytes(b64url) {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/* =====================================================================
   DATA LAYER - real backend (Supabase)
   ===================================================================== */
function supabaseApi() {
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  const email = (u) => `wg-${u.toLowerCase()}@${CFG.AUTH_EMAIL_DOMAIN || 'users.noreply.github.com'}`;
  let uid = null;
  const q = async (promise) => { const { data, error } = await promise; if (error) throw error; return data; };

  return {
    async init() {
      const { data } = await sb.auth.getSession();
      uid = data.session ? data.session.user.id : null;
      return !!uid;
    },
    async signUp(username, password) {
      const free = await q(sb.rpc('username_available', { name: username }));
      if (!free) throw new Error('That username is taken');
      const { data, error } = await sb.auth.signUp({ email: email(username), password, options: { data: { username } } });
      if (error) throw error;
      if (!data.session) throw new Error('Account made, but "Confirm email" is still switched on in Supabase. See README step 2.');
      uid = data.session.user.id;
    },
    async signIn(username, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email: email(username), password });
      if (error) throw new Error(/invalid login/i.test(error.message) ? 'Wrong username or password' : error.message);
      uid = data.session.user.id;
    },
    async signOut() {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
      } catch (_) { /* best effort */ }
      await sb.auth.signOut();
      uid = null;
    },
    async load() {
      const me = await q(sb.from('profiles').select('*').eq('id', uid).single());
      const ids = (await q(sb.from('party_members').select('party_id').eq('user_id', uid))).map((r) => r.party_id);
      const since = new Date(Date.now() - SESSION_MS).toISOString();
      const none = Promise.resolve([]);
      const [parties, members, invites, sessions, availability, reqs, stats] = await Promise.all([
        ids.length ? q(sb.from('parties').select('id,name,owner_id').in('id', ids).order('created_at')) : none,
        ids.length ? q(sb.from('party_members').select('party_id,user_id,profiles!party_members_user_id_fkey(username,controller)').in('party_id', ids)) : none,
        ids.length ? q(sb.from('party_invites').select('party_id,code').in('party_id', ids)) : none,
        q(sb.from('sessions')
          .select('id,user_id,platform,started_at,profiles!sessions_user_id_fkey(username,controller),responses!responses_session_id_fkey(user_id,text,created_at,profiles!responses_user_id_fkey(username))')
          .is('ended_at', null).gt('started_at', since).order('started_at', { ascending: false })),
        q(sb.from('availability').select('user_id,day,slot').gte('day', dayKey(new Date()))),
        q(sb.from('join_requests').select('id,party_id,user_id,parties!join_requests_party_id_fkey(name),profiles!join_requests_user_id_fkey(username)')),
        // Stats come from one database function; null if the database script has not been re-run yet.
        sb.rpc('get_stats', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }).then((r) => (r.error ? null : r.data), () => null)
      ]);
      return {
        me: { id: me.id, username: me.username, custom_replies: me.custom_replies || [], look: me.controller || {} },
        stats,
        parties: parties.map((p) => ({
          ...p,
          code: (invites.find((i) => i.party_id === p.id) || {}).code || '',
          members: members.filter((m) => m.party_id === p.id)
            .map((m) => ({ id: m.user_id, username: m.profiles ? m.profiles.username : '?' }))
            .sort((a, b) => a.username.localeCompare(b.username))
        })),
        sessions: sessions.map((s) => ({
          id: s.id, user_id: s.user_id, username: s.profiles ? s.profiles.username : '?',
          platform: s.platform, started_at: s.started_at, look: s.profiles ? s.profiles.controller : null,
          responses: (s.responses || []).map((r) => ({ user_id: r.user_id, username: r.profiles ? r.profiles.username : '?', text: r.text, created_at: r.created_at }))
        })),
        availability,
        incoming: reqs.filter((r) => r.user_id !== uid).map((r) => ({ id: r.id, party_id: r.party_id, party_name: r.parties ? r.parties.name : '', username: r.profiles ? r.profiles.username : '?' })),
        outgoing: reqs.filter((r) => r.user_id === uid).map((r) => r.party_id)
      };
    },
    // The database does the check-in: it stamps the time and, if you are already on,
    // hands back that session ({ id, started_at, is_new: false }) instead of making another.
    startSession: (platform) => q(sb.rpc('check_in', { p_platform: platform })),
    respond: (session_id, text) => q(sb.rpc('send_reply', { p_session: session_id, p_text: text })),
    setAvailability: (day, slot, on) => on
      ? q(sb.from('availability').upsert({ user_id: uid, day, slot }, { ignoreDuplicates: true }))
      : q(sb.from('availability').delete().eq('user_id', uid).eq('day', day).eq('slot', slot)),
    createParty: (name) => q(sb.from('parties').insert({ name, owner_id: uid })),
    leaveParty: (party) => party.owner_id === uid
      ? q(sb.from('parties').delete().eq('id', party.id))
      : q(sb.from('party_members').delete().eq('party_id', party.id).eq('user_id', uid)),
    async searchUsers(term) {
      const rows = await q(sb.rpc('search_users', { q: term }));
      const out = [];
      rows.forEach((r) => {
        let u = out.find((x) => x.id === r.user_id);
        if (!u) { u = { id: r.user_id, username: r.username, parties: [] }; out.push(u); }
        if (r.party_id) u.parties.push({ id: r.party_id, name: r.party_name });
      });
      return out;
    },
    requestJoin: (party_id) => q(sb.from('join_requests').insert({ party_id, user_id: uid }).select('id').single()),
    answerRequest: (id, accept) => q(sb.rpc('answer_request', { req: id, accept })),
    joinByCode: (code) => q(sb.rpc('join_party_by_code', { invite: code })),
    saveCustomReplies: (list) => q(sb.from('profiles').update({ custom_replies: list }).eq('id', uid)),
    saveLook: (look) => q(sb.from('profiles').update({ controller: look }).eq('id', uid)),
    savePushSub(sub) {
      const j = sub.toJSON();
      return q(sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }));
    },
    // Asks the "notify" edge function to push to the right people.
    async notify(body) {
      const { data, error } = await sb.functions.invoke('notify', { body });
      if (error) { console.warn('notify failed', error); throw error; }
      return data;
    },
    onChange(cb) {
      sb.channel('wg-live').on('postgres_changes', { event: '*', schema: 'public' }, cb).subscribe();
    }
  };
}

/* =====================================================================
   DATA LAYER - demo mode (no backend yet; pretend friends, nothing is saved)
   ===================================================================== */
function demoApi() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayKey(d); };
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const friends = [{ id: 'u1', username: 'Sam' }, { id: 'u2', username: 'Priya' }, { id: 'u3', username: 'Jonno' }];
  let me = null;
  let db = null;
  let seq = 1;
  let tally = null;
  const planned = new Set();          // every slot ever ticked; unticking does not remove it
  const cast = { u1: [31, 12, { body: 'purple', buttons: 'white' }], u2: [14, 27, { body: 'crimson', buttons: 'pink', ring: 'cyan' }], u3: [6, 8, { body: 'ice' }] };
  const seed = () => ({
    parties: [{ id: 'p1', name: 'The Squad', owner_id: 'me', code: 'SQ4D42', members: [...friends] }],
    sessions: [{ id: 's1', user_id: 'u1', username: 'Sam', platform: PLATFORMS[0], started_at: ago(12), look: cast.u1[2],
      responses: [{ user_id: 'u2', username: 'Priya', text: 'Will be 30', created_at: ago(8) }] }],
    availability: [['u1', 0, 'eve'], ['u2', 0, 'eve'], ['u3', 1, 'eve'], ['u1', 1, 'eve'], ['u2', 2, 'pm'], ['u1', 4, 'eve'],
      ['u2', 4, 'eve'], ['u3', 4, 'eve'], ['u3', 5, 'am'], ['u1', 5, 'pm'], ['u2', 5, 'pm']].map(([user_id, n, slot]) => ({ user_id, day: day(n), slot })),
    incoming: [{ id: 'r1', party_id: 'p1', party_name: 'The Squad', username: 'Kaz' }],
    outgoing: []
  });
  const start = (username) => {
    me = { id: 'me', username, custom_replies: [], look: {} };
    tally = { checkins: 9, replies: 9 };      // one tap away from a trophy, to show how unlocking feels
    db = seed();
    db.parties[0].members.push({ id: 'me', username });
    store.set('wg-demo-user', username);
  };
  return {
    async init() { const u = store.get('wg-demo-user'); if (u) start(u); return !!u; },
    async signUp(username) { start(username); },
    async signIn(username) { start(username); },
    async signOut() { me = null; store.del('wg-demo-user'); },
    async load() {
      db.sessions = db.sessions.filter((s) => !expired(s));
      const stats = {
        me: { ...NO_STATS, ...tally, night: 1, weekend: 3, streak: 2, received: 7, rally: 2, top_day: 5, top_slot: 'eve', top_hour: 20,
          planned: 6 + planned.size, since: ago(60 * 24 * 75) },
        parties: db.parties.map((p) => {
          const members = p.members.map((m) => ({ id: m.id, username: m.username,
            checkins: m.id === 'me' ? tally.checkins : (cast[m.id] || [0])[0], replies: m.id === 'me' ? tally.replies : (cast[m.id] || [0, 0])[1],
            controller: m.id === 'me' ? me.look : (cast[m.id] || [])[2] || {} }));
          return { id: p.id, name: p.name, members, checkins: members.reduce((n, m) => n + m.checkins, 0), top_day: 6, top_slot: 'eve' };
        })
      };
      return JSON.parse(JSON.stringify({ me, stats, ...db }));
    },
    async startSession(platform) {
      await new Promise((r) => setTimeout(r, 150));           // behave like a real network call
      const running = db.sessions.find((s) => s.user_id === 'me' && !expired(s));
      if (running) return { id: running.id, started_at: running.started_at, is_new: false };
      const s = { id: `s${++seq}`, user_id: 'me', username: me.username, platform, started_at: new Date().toISOString(), look: me.look, responses: [] };
      tally.checkins++;
      db.sessions.unshift(s);
      // Pretend a friend answers a few seconds later.
      setTimeout(() => { if (db && db.sessions.includes(s)) { s.responses.push({ user_id: 'u3', username: 'Jonno', text: 'On my way', created_at: new Date().toISOString() }); changed(); } }, 3500);
      return { id: s.id, started_at: s.started_at, is_new: true };
    },
    async respond(session_id, text) {
      const s = db.sessions.find((x) => x.id === session_id);
      if (!s.responses.some((r) => r.user_id === 'me')) tally.replies++;
      s.responses = s.responses.filter((r) => r.user_id !== 'me');
      s.responses.push({ user_id: 'me', username: me.username, text, created_at: new Date().toISOString() });
    },
    async setAvailability(d, slot, on) {
      db.availability = db.availability.filter((a) => !(a.user_id === 'me' && a.day === d && a.slot === slot));
      if (on) { db.availability.push({ user_id: 'me', day: d, slot }); planned.add(`${d}|${slot}`); }
    },
    async createParty(name) { db.parties.push({ id: `p${++seq}`, name, owner_id: 'me', code: 'DEMO' + seq, members: [{ id: 'me', username: me.username }] }); },
    async leaveParty(party) { db.parties = db.parties.filter((p) => p.id !== party.id); },
    async searchUsers(term) {
      return [{ id: 'u9', username: 'Kaz', parties: [{ id: 'p9', name: 'Night Shift' }] }, { id: 'u8', username: 'Morven', parties: [] }]
        .filter((u) => u.username.toLowerCase() === term.toLowerCase());
    },
    async requestJoin(party_id) { db.outgoing.push(party_id); return { id: 'x' }; },
    async answerRequest(id, accept) {
      const r = db.incoming.find((x) => x.id === id);
      db.incoming = db.incoming.filter((x) => x.id !== id);
      if (accept && r) db.parties.find((p) => p.id === r.party_id).members.push({ id: 'u9', username: r.username });
    },
    async joinByCode() { throw new Error('Invite codes need the real backend. See README.'); },
    async saveCustomReplies(list) { me.custom_replies = list; },
    async saveLook(look) { me.look = look; },
    async savePushSub() {},
    async notify(body) {
      if (body.type !== 'test') return {};
      const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
      if (reg && Notification.permission === 'granted') await reg.showNotification('Sam is gaming', { body: 'On ' + PLATFORMS[0] + '. Demo notification.', icon: 'icons/icon-192.png' });
      return { sent: 1 };
    },
    onChange(cb) { changed = cb; }
  };
}
let changed = () => {};

/* =====================================================================
   APP STATE
   ===================================================================== */
const api = DEMO ? demoApi() : supabaseApi();
const state = {
  authed: false, authMode: 'signin', view: 'home', data: null,
  platform: PLATFORMS[0], customFor: null, cell: null, partyFilter: 'all',
  search: null, push: 'off', installEvt: null, animUntil: 0, menu: false
};
const me = () => state.data.me;
const myStats = () => ({ ...NO_STATS, ...((state.data.stats && state.data.stats.me) || {}) });
const unlocked = (t) => (myStats()[t.stat] || 0) >= t.goal;
const lookTrophy = (part, key) => TROPHIES.find((t) => t.part === part && t.look === key);

// Congratulate once per newly earned trophy (remembered on this device).
function announceTrophies() {
  if (!state.data || !state.data.stats) return;
  const key = `wg-trophies-${me().id}`;
  const have = TROPHIES.filter(unlocked).map((t) => t.id);
  const seen = store.get(key);
  if (seen !== null) {
    const before = seen.split(',');
    TROPHIES.filter((t) => have.includes(t.id) && !before.includes(t.id)).forEach((fresh) => toast(`Trophy: ${fresh.name}. ${LOOKS[fresh.part][fresh.look][0]} ${fresh.part === 'body' ? 'controller' : fresh.part} unlocked.`));
  }
  store.set(key, have.join(','));
}
const endsAt = (s) => new Date(s.started_at).getTime() + SESSION_MS;
const expired = (s) => Date.now() >= endsAt(s);
const ringOffset = (s) => (RING * Math.min(1, Math.max(0, (Date.now() - new Date(s.started_at).getTime()) / SESSION_MS))).toFixed(1);
const mySession = () => state.data.sessions.find((s) => s.user_id === me().id);
const replyOptions = () => [...DEFAULT_REPLIES, ...me().custom_replies.filter((r) => !DEFAULT_REPLIES.includes(r))];

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, Math.max(200, state.animUntil - Date.now()));
}
async function refresh() {
  if (!state.authed) return;
  try { state.data = await api.load(); } catch (err) { console.warn(err); return; }
  announceTrophies();
  // Don't yank the page out from under someone who is typing.
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
  if (!typing) render();
}

/* =====================================================================
   RENDERING
   ===================================================================== */
const PAD_PATH = 'M72 26H168C200 26 216 48 223 84C229 114 233 136 219 146C205 156 190 141 177 119C173 112 168 110 160 110H80C72 110 67 112 63 119C50 141 35 156 21 146C7 136 11 114 17 84C24 48 40 26 72 26Z';
const ARCADE = ['#22d3ee', '#ff5fa2', '#f5c542', '#ff7a1a'];
let padSeq = 0;
// Draws a controller in someone's chosen colours. Colours only show once it is "on".
function controllerSvg(style) {
  const look = lookOf(style);
  const id = `pad${++padSeq}`;
  const body = LOOKS.body[look.body][1];
  const btn = LOOKS.buttons[look.buttons][1];
  const prism = body === 'prism';
  const face = [[172, 58], [172, 90], [156, 74], [188, 74]]
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="7"${btn === 'arcade' ? ` style="--c-btn:${ARCADE[i]}"` : ''}/>`).join('');
  return `<svg class="pad" viewBox="0 0 240 172" aria-hidden="true" style="--c-btn:${btn === 'arcade' ? '#0d1017' : btn};--c-glow:${prism ? '#a06bff' : body}">
    <defs><clipPath id="${id}"><path d="${PAD_PATH}"/></clipPath>
      ${prism ? `<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="0.5" stop-color="#a06bff"/><stop offset="1" stop-color="#ff5fa2"/></linearGradient>` : ''}</defs>
    <g clip-path="url(#${id})">
      <rect class="pad-base" width="240" height="172"/>
      <rect class="pad-fill" width="240" height="172" style="fill:${prism ? `url(#${id}g)` : body}"/>
    </g>
    <g class="pad-marks">
      <rect x="62" y="56" width="12" height="36" rx="3"/><rect x="50" y="68" width="36" height="12" rx="3"/>
      ${face}
      <rect x="103" y="50" width="12" height="6" rx="3"/><rect x="125" y="50" width="12" height="6" rx="3"/>
    </g>
  </svg>`;
}

function render() {
  const app = $('#app');
  if (!state.authed) { app.innerHTML = authView(); return; }
  if (!state.data) { app.innerHTML = '<p class="boot">Loading…</p>'; return; }
  const views = { home: homeView, week: weekView, party: partyView, stats: statsView, trophies: trophiesView, customise: customiseView, settings: settingsView };
  const badge = state.data.incoming.length ? `<i class="dot">${state.data.incoming.length}</i>` : '';
  const tab = (id, label, icon, extra = '') => `<button class="tab ${state.view === id ? 'active' : ''}" data-act="view" data-view="${id}">${icon}<span>${label}</span>${extra}</button>`;
  // The page is redrawn often; the menu lives beside it so its slide animation is never interrupted.
  if (!$('#page')) {
    app.innerHTML = '<div id="page"></div><div class="scrim" data-act="menuclose"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Menu" inert></aside>';
    state.menu = false;
  }
  $('#page').innerHTML = `
    ${DEMO ? '<div class="demo">Demo mode. Pretend friends, nothing saved. Follow README.md to go live.</div>' : ''}
    <header class="top">
      <button class="menu-btn" data-act="menu" aria-label="Menu" aria-expanded="${!!state.menu}"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
      <b>Game With Me</b>
      <button class="mini on top-pad" data-act="view" data-view="customise" aria-label="Customise your controller">${controllerSvg(me().look)}</button>
    </header>
    <main class="view">${views[state.view]()}</main>
    <nav class="tabs">
      ${tab('home', 'Play', '<svg viewBox="0 0 24 24"><path d="M7 7h10a5 5 0 0 1 5 5v2a3 3 0 0 1-5.4 1.8L15.5 14h-7l-1.1 1.8A3 3 0 0 1 2 14v-2a5 5 0 0 1 5-5z"/></svg>')}
      ${tab('week', 'Week', '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>')}
      ${tab('party', 'Party', '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5"/></svg>', badge)}
    </nav>`;
  if (!state.menu) $('.drawer').innerHTML = drawerHtml();   // left alone while open, so focus inside it is kept
}

const MENU = [
  ['stats', 'Stats', '<path d="M5 20V11M12 20V4M19 20v-6"/>'],
  ['trophies', 'Trophies', '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/>'],
  ['customise', 'Customise', '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>'],
  ['settings', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>']
];
function drawerHtml() {
  const got = TROPHIES.filter(unlocked).length;
  return `<div class="prof"><span class="mini big on">${controllerSvg(me().look)}</span>
      <div><h4>${esc(me().username)}</h4><p class="muted small">${myStats().checkins} check-ins · ${got} trophies</p></div>
      <button class="menu-btn close" data-act="menuclose" aria-label="Close menu"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    ${MENU.map(([id, label, icon]) => `<button class="item ${state.view === id ? 'active' : ''}" data-act="view" data-view="${id}">
      <svg viewBox="0 0 24 24">${icon}</svg><span>${label}</span>${id === 'trophies' ? `<small>${got}/${TROPHIES.length}</small>` : ''}</button>`).join('')}
    <button class="item out" data-act="signout"><svg viewBox="0 0 24 24"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/></svg><span>Sign out</span></button>`;
}
// Opening moves keyboard and screen-reader focus into the menu and switches the page behind off;
// closing hands focus back to the menu button.
function setMenu(open) {
  const was = state.menu;
  state.menu = open;
  const drawer = $('.drawer');
  if (!drawer) return;
  if (open) drawer.innerHTML = drawerHtml();
  drawer.classList.toggle('open', open);
  $('.scrim').classList.toggle('open', open);
  drawer.inert = !open;
  $('#page').inert = open;
  const btn = $('.top .menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
  if (open) (drawer.querySelector('.item.active') || drawer.querySelector('.item')).focus();
  else if (was && btn) btn.focus();
}

function authView() {
  const up = state.authMode === 'signup';
  return `<main class="auth">
    <div class="auth-pad on">${controllerSvg()}</div>
    <h1>Game With Me</h1>
    <p class="muted">One tap tells your party you're on.</p>
    ${DEMO ? '<p class="demo inline">Demo mode: any username and password works.</p>' : ''}
    <form data-form="auth" class="card stack">
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required placeholder="3 to 20 letters, numbers or _"></label>
      <label>Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required placeholder="At least 6 characters"></label>
      <button class="btn primary">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <button class="link" data-act="authmode">${up ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
    ${up ? '<p class="muted small">There is no email on file, so a forgotten password cannot be reset. Pick one you will remember.</p>' : ''}
  </main>`;
}

function homeView() {
  const mine = mySession();
  const others = state.data.sessions.filter((s) => s.user_id !== me().id);
  const noParty = !state.data.parties.length;
  const nudge = state.push === 'off' || state.push === 'needs-install'
    ? `<button class="nudge" data-act="view" data-view="settings">Turn on notifications so you never miss the call <b>›</b></button>` : '';
  const platforms = PLATFORMS.length > 1 && !mine
    ? `<div class="chips center">${PLATFORMS.map((p) => `<button class="chip ${state.platform === p ? 'active' : ''}" data-act="platform" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : '';

  const replies = (s) => s.responses.length
    ? `<ul class="replies">${s.responses.map((r) => `<li><b>${esc(r.user_id === me().id ? 'You' : r.username)}</b> ${esc(r.text)}<span class="muted">${eta(r.text, r.created_at)}</span></li>`).join('')}</ul>` : '';

  const card = (s) => {
    const my = s.responses.find((r) => r.user_id === me().id);
    return `<article class="card session">
      <header><span class="avatar live">${initial(s.username)}</span>
        <div><b>${esc(s.username)}</b> is on ${esc(s.platform)}
          <div class="muted small">since ${clock(s.started_at)}</div></div><span class="mini on end">${controllerSvg(s.look)}</span></header>
      ${replies(s)}
      <div class="chips">
        ${replyOptions().map((t) => `<button class="chip ${my && my.text === t ? 'active' : ''}" data-act="reply" data-s="${s.id}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}
        <button class="chip ghost" data-act="custom" data-s="${s.id}">+ Your own</button>
      </div>
      ${state.customFor === s.id ? `<form data-form="custom" data-s="${s.id}" class="row"><input name="text" maxlength="40" placeholder="e.g. After the school run" required><button class="btn primary">Send</button></form>` : ''}
    </article>`;
  };

  return `
    ${nudge}
    <section class="hero">
      <button class="pad-btn ${mine ? 'on' : ''}" data-act="toggle" aria-pressed="${!!mine}" aria-label="${mine ? "You're on" : "Tell your party you're gaming"}" ${noParty ? 'disabled' : ''} style="--c-ring:${LOOKS.ring[lookOf(me().look).ring][1]}">
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="47"/><circle class="ring-left" cx="50" cy="50" r="47" style="stroke-dashoffset:${mine ? ringOffset(mine) : 0}"/></svg>
        ${controllerSvg(me().look)}
      </button>
      <h2>${mine ? "You're on" : noParty ? 'Join a party first' : "Tap when you're on"}</h2>
      <p class="muted">${mine ? `${esc(mine.platform)} · clears itself at ${clock(endsAt(mine))}`
        : noParty ? 'Create one or find your friends in the Party tab.' : 'Your party gets a notification straight away.'}</p>
      ${platforms}
    </section>
    ${mine ? `<h3>Replies</h3>${mine.responses.length ? `<div class="card">${replies(mine)}</div>` : '<p class="muted empty">Nobody has answered yet.</p>'}` : ''}
    <h3>On now</h3>
    ${others.length ? others.map(card).join('') : '<p class="muted empty">Nobody else is on. Be the one who starts it.</p>'}`;
}

function weekDays() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    return { key: dayKey(d), name: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }), num: d.getDate(), long: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'long' }) };
  });
}

function weekView() {
  const { parties, availability } = state.data;
  if (!parties.length) return '<h2 class="title">Week ahead</h2><p class="muted empty">Join a party to plan the week together.</p>';
  if (state.partyFilter !== 'all' && !parties.some((p) => p.id === state.partyFilter)) state.partyFilter = 'all';   // left that party
  const scope = state.partyFilter === 'all' ? parties : parties.filter((p) => p.id === state.partyFilter);
  const people = new Map();
  scope.forEach((p) => p.members.forEach((m) => people.set(m.id, m.username)));
  const days = weekDays();
  const who = (day, slot) => availability.filter((a) => a.day === day && a.slot === slot && people.has(a.user_id))
    .map((a) => ({ id: a.user_id, name: a.user_id === me().id ? 'You' : people.get(a.user_id) }))
    .sort((a, b) => (a.name === 'You' ? -1 : b.name === 'You' ? 1 : a.name.localeCompare(b.name)));

  const best = [];
  days.forEach((d) => SLOTS.forEach(([slot, , word]) => { const w = who(d.key, slot); if (w.length >= 2) best.push({ d, word, w }); }));
  best.sort((a, b) => b.w.length - a.w.length);

  const filter = parties.length > 1
    ? `<div class="chips">${[{ id: 'all', name: 'All parties' }, ...parties].map((p) => `<button class="chip ${state.partyFilter === p.id ? 'active' : ''}" data-act="pfilter" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : '';

  const grid = days.map((d) => `<div class="wk-row">
      <div class="wk-day"><b>${d.name}</b><span>${d.num}</span></div>
      ${SLOTS.map(([slot, label]) => {
        const w = who(d.key, slot);
        const mine = w.some((x) => x.id === me().id);
        const heat = Math.min(4, Math.ceil((w.length / Math.max(2, people.size)) * 4));
        const sel = state.cell === `${d.key}|${slot}`;
        return `<button class="wk-cell h${heat} ${mine ? 'mine' : ''} ${sel ? 'sel' : ''}" data-act="avail" data-day="${d.key}" data-slot="${slot}"
          aria-pressed="${sel}" aria-label="${d.long} ${label}, ${w.length} in${mine ? ', including you' : ''}. ${sel ? 'Tap again to ' + (mine ? 'drop out' : 'join') : 'Tap to see who'}">
          <span class="wk-n">${w.length || ''}</span><span class="wk-who">${w.slice(0, 4).map((x) => `<i>${initial(x.name)}</i>`).join('')}</span></button>`;
      }).join('')}
    </div>`).join('');

  let detail = '<div class="card slot"><p class="muted small">Tap a slot to see who is in. Tap it again, or use the button here, to add or remove yourself.</p></div>';
  if (state.cell) {
    const [day, slot] = state.cell.split('|');
    const d = days.find((x) => x.key === day);
    if (d) {
      const w = who(day, slot);
      const mine = w.some((x) => x.id === me().id);
      detail = `<div class="card slot"><div><b>${d.long} ${SLOTS.find((s) => s[0] === slot)[2]}</b>
          <div class="small ${w.length ? '' : 'muted'}">${w.length ? esc(w.map((x) => x.name).join(', ')) : 'Nobody yet'}</div></div>
        <button class="btn sm ${mine ? '' : 'primary'}" data-act="availset" data-day="${day}" data-slot="${slot}" data-on="${mine ? '' : '1'}">${mine ? "I'm out" : "I'm in"}</button></div>`;
    }
  }

  return `<h2 class="title">Week ahead</h2>
    ${filter}
    ${best.length ? `<div class="card best"><span class="muted small">Best bets</span>${best.slice(0, 3).map((b) => `<div><b>${b.d.long} ${b.word}</b> · ${b.w.length} in <span class="muted">(${esc(b.w.map((x) => x.name).join(', '))})</span></div>`).join('')}</div>` : ''}
    <div class="wk">
      <div class="wk-row head"><div></div>${SLOTS.map(([, label]) => `<div>${label}</div>`).join('')}</div>
      ${grid}
    </div>
    ${detail}`;
}

function partyView() {
  const { parties, incoming, outgoing } = state.data;
  const myPartyIds = parties.map((p) => p.id);
  const requests = incoming.length ? `<h3>Requests</h3>${incoming.map((r) => `<div class="card row between">
      <div><b>${esc(r.username)}</b> wants to join <b>${esc(r.party_name)}</b></div>
      <div class="row"><button class="btn primary sm" data-act="answer" data-id="${r.id}" data-ok="1">Accept</button><button class="btn sm" data-act="answer" data-id="${r.id}">Decline</button></div>
    </div>`).join('')}` : '';

  const list = parties.map((p) => {
    const owner = p.owner_id === me().id;
    return `<article class="card">
      <header class="row between"><h4>${esc(p.name)}</h4><span class="muted small">${p.members.length} ${p.members.length === 1 ? 'member' : 'members'}</span></header>
      <div class="members">${p.members.map((m) => `<span class="member"><span class="avatar">${initial(m.username)}</span>${esc(m.username)}${m.id === p.owner_id ? ' <em>host</em>' : ''}</span>`).join('')}</div>
      <div class="row between invite"><span class="muted small">Invite code <code>${esc(p.code)}</code></span>
        <span class="row"><button class="btn sm" data-act="share" data-id="${p.id}">Share invite</button>
        <button class="btn sm danger" data-act="leave" data-id="${p.id}">${owner ? 'Delete' : 'Leave'}</button></span></div>
    </article>`;
  }).join('');

  let results = '';
  if (state.search) {
    results = state.search.length ? state.search.map((u) => `<div class="card">
        <div class="row"><span class="avatar">${initial(u.username)}</span><b>${esc(u.username)}</b></div>
        ${u.parties.length ? u.parties.map((p) => {
          const st = myPartyIds.includes(p.id) ? 'Member' : outgoing.includes(p.id) ? 'Requested' : '';
          return `<div class="row between sub"><span>${esc(p.name)}</span>${st ? `<span class="muted small">${st}</span>` : `<button class="btn primary sm" data-act="request" data-id="${p.id}">Ask to join</button>`}</div>`;
        }).join('') : '<p class="muted small">Not in a party yet. Send them your invite instead.</p>'}
      </div>`).join('') : '<p class="muted empty">Nobody has exactly that username. Check the spelling, or send them your invite instead.</p>';
  }

  return `<h2 class="title">Parties</h2>
    ${requests}
    ${list || '<p class="muted empty">You are not in a party yet. Start one below, or find a friend.</p>'}
    <h3>Find a friend</h3>
    <form data-form="search" class="row"><input name="q" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="Their exact username" required minlength="3"><button class="btn">Search</button></form>
    ${results}
    <h3>Got an invite code?</h3>
    <form data-form="code" class="row"><input name="code" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="e.g. A1B2C3" required><button class="btn">Join</button></form>
    <h3>Start a party</h3>
    <form data-form="party" class="row"><input name="name" maxlength="30" placeholder="Party name" required><button class="btn primary">Create</button></form>`;
}

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SLOT_WORD = { am: 'morning', pm: 'afternoon', eve: 'evening' };

function statsView() {
  if (!state.data.stats) return '<h2 class="title">Stats</h2><p class="muted empty">Stats need the latest database script. Run supabase/schema.sql in Supabase again (it is safe to re-run), then reopen the app.</p>';
  const st = myStats();
  const tile = (n, label) => `<div class="tile"><b>${n}</b><span>${label}</span></div>`;
  const fav = st.checkins
    ? `<b>${DAY_NAMES[st.top_day]}s</b>, mostly in the <b>${SLOT_WORD[st.top_slot]}</b><div class="muted small">You usually check in around ${pad2(st.top_hour)}:00</div>`
    : '<span class="muted">Check in a few times and this fills in.</span>';

  const board = (members, key) => {
    const rows = [...members].sort((x, y) => y[key] - x[key] || x.username.localeCompare(y.username));
    const max = Math.max(1, rows[0][key]);
    return rows.map((m, i) => `<div class="rank ${m.id === me().id ? 'you' : ''}">
        <span class="pos">${m[key] && i === 0 ? '<svg viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>' : i + 1}</span>
        <span class="mini on">${controllerSvg(m.controller)}</span>
        <span class="who">${esc(m.id === me().id ? 'You' : m.username)}<i style="width:${Math.round((m[key] / max) * 100)}%"></i></span>
        <b>${m[key]}</b></div>`).join('');
  };
  const parties = state.data.stats.parties.map((p) => `<h3>${esc(p.name)}</h3>
    <div class="card">
      <p>${p.checkins ? `Most popular: <b>${DAY_NAMES[p.top_day]} ${SLOT_WORD[p.top_slot]}</b> <span class="muted">· ${p.checkins} check-ins all time</span>` : '<span class="muted">No check-ins yet. Somebody go first.</span>'}</p>
      <h5>Most check-ins</h5>${board(p.members, 'checkins')}
      <h5>Most replies</h5>${board(p.members, 'replies')}
    </div>`).join('');

  const since = st.since ? `Playing since ${new Date(st.since).toLocaleDateString([], { month: 'long', year: 'numeric' })}` : '';
  return `<h2 class="title">Stats</h2><p class="muted small lead">${since}</p>
    <div class="tiles">
      ${tile(st.checkins, 'Check-ins')}${tile(st.replies, 'Replies sent')}
      ${tile(st.received, 'Replies received')}${tile(st.streak + (st.streak === 1 ? ' day' : ' days'), 'Best streak')}
      ${tile(st.planned, 'Slots planned')}${tile(st.rally, 'Biggest turnout')}
    </div>
    <h3>Your favourite time</h3><div class="card"><p>${fav}</p></div>
    ${parties}`;
}

function customiseView() {
  const look = lookOf(me().look);
  const swatches = (part) => Object.entries(LOOKS[part]).map(([key, [label, colour]]) => {
    const need = lookTrophy(part, key);
    const open = !need || unlocked(need);
    const bg = colour === 'prism' ? 'linear-gradient(135deg,#22d3ee,#a06bff,#ff5fa2)'
      : colour === 'arcade' ? 'conic-gradient(#22d3ee 0 25%,#ff5fa2 0 50%,#f5c542 0 75%,#ff7a1a 0)' : colour;
    return `<button class="swatch ${look[part] === key ? 'sel' : ''} ${open ? '' : 'locked'}" style="background:${bg}" data-act="look" data-part="${part}" data-key="${key}"
      aria-label="${esc(label)}${open ? '' : ', locked: ' + esc(need.name)}" aria-pressed="${look[part] === key}">${open ? '' : LOCK}</button>`;
  }).join('');
  return `<h2 class="title">Customise</h2><p class="muted small lead">Earn trophies to unlock more colours. Your party sees your controller next to your name.</p>
    <div class="card custom">
      <div class="preview on" style="--c-ring:${LOOKS.ring[look.ring][1]}">
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="47"/><circle class="ring-left" cx="50" cy="50" r="47" style="stroke-dashoffset:${(RING * 0.25).toFixed(1)}"/></svg>
        ${controllerSvg(look)}</div>
      <h5>Controller</h5><div class="swatches">${swatches('body')}</div>
      <h5>Buttons</h5><div class="swatches">${swatches('buttons')}</div>
      <h5>Ring</h5><div class="swatches">${swatches('ring')}</div>
    </div>
    <button class="btn wide" data-act="view" data-view="trophies">See trophies</button>`;
}

function trophiesView() {
  const st = myStats();
  const partName = { body: 'controller', buttons: 'buttons', ring: 'ring' };
  const row = (t) => {
    const have = unlocked(t);
    const n = Math.min(st[t.stat] || 0, t.goal);
    return `<div class="trophy ${have ? 'have' : ''}">
      <span class="medal">${have ? CUP : LOCK}</span>
      <div><b>${t.name}</b><div class="muted small">${t.desc}</div>
        ${have ? '' : `<div class="bar"><i style="width:${Math.round((n / t.goal) * 100)}%"></i></div>`}
        <div class="small reward">${have ? 'Unlocked' : `${n} / ${t.goal}`} · ${LOOKS[t.part][t.look][0]} ${partName[t.part]}</div></div>
    </div>`;
  };
  const got = TROPHIES.filter(unlocked).length;
  return `<h2 class="title">Trophies</h2><p class="muted small lead">${got} of ${TROPHIES.length} earned. Each one unlocks a colour in Customise.</p>
    ${[...TROPHIES].sort((x, y) => unlocked(y) - unlocked(x)).map(row).join('')}`;
}

function settingsView() {
  const push = {
    on: `<p class="ok">Notifications are on for this device.</p><button class="btn" data-act="test">Send me a test</button>`,
    off: `<p class="muted">Get a ping the moment someone in your party is on.</p><button class="btn primary" data-act="push">Enable notifications</button>`,
    denied: `<p class="muted">Notifications are blocked for this app. Allow them in your phone or browser settings, then come back.</p>`,
    'needs-install': `<p class="muted">On iPhone and iPad, notifications only work once the app is on your Home Screen:</p>
      <ol class="steps"><li>Open this page in <b>Safari</b></li><li>Tap <b>Share</b>, then <b>Add to Home Screen</b></li><li>Open Game With Me from the new icon and come back here</li></ol>`,
    unsupported: `<p class="muted">This browser cannot receive push notifications. Try Chrome on Android, or Safari on iPhone.</p>`,
    unconfigured: `<p class="muted">Add your VAPID public key to config.js to switch notifications on (README step 5).</p>`
  }[state.push];
  const install = isStandalone ? '' : state.installEvt
    ? `<h3>Install</h3><div class="card"><p class="muted">Put Game With Me on your home screen for one-tap access.</p><button class="btn primary" data-act="install">Add to home screen</button></div>`
    : (isIOS && state.push !== 'needs-install' ? `<h3>Install</h3><div class="card"><p class="muted">In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>.</p></div>` : '');
  const custom = me().custom_replies;
  return `<h2 class="title">Settings</h2><p class="muted small lead">Signed in as ${esc(me().username)}. Friends find you by this username.</p>
    <h3>Notifications</h3><div class="card">${push}</div>
    ${install}
    <h3>Your quick replies</h3>
    <div class="card">
      <div class="chips">${DEFAULT_REPLIES.map((r) => `<span class="chip static">${esc(r)}</span>`).join('')}
        ${custom.map((r, i) => `<button class="chip active" data-act="delreply" data-i="${i}" aria-label="Remove ${esc(r)}">${esc(r)} ✕</button>`).join('')}</div>
      <form data-form="addreply" class="row"><input name="text" maxlength="40" placeholder="Add your own" required><button class="btn">Add</button></form>
    </div>
    <button class="btn wide" data-act="signout">Sign out</button>`;
}

/* =====================================================================
   PUSH NOTIFICATIONS
   ===================================================================== */
async function checkPush() {
  if (!pushSupported) state.push = isIOS && !isStandalone ? 'needs-install' : 'unsupported';
  else if (isIOS && !isStandalone) state.push = 'needs-install';
  else if (!DEMO && !CFG.VAPID_PUBLIC_KEY) state.push = 'unconfigured';
  else if (Notification.permission === 'denied') state.push = 'denied';
  else if (Notification.permission !== 'granted') state.push = 'off';
  else if (DEMO) state.push = 'on';
  else {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      state.push = sub ? 'on' : 'off';
      if (sub) api.savePushSub(sub).catch(() => {});   // keeps the server copy fresh
    } catch (_) { state.push = 'off'; }
  }
}

// Must run from a tap: iOS only shows the permission prompt in response to one.
async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { await checkPush(); render(); return; }
  if (!DEMO) {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
    await api.savePushSub(sub);
  }
  await checkPush();
  render();
  toast('Notifications on');
}

/* =====================================================================
   ACTIONS
   ===================================================================== */
const actions = {
  authmode() { state.authMode = state.authMode === 'signup' ? 'signin' : 'signup'; render(); },
  view(el) {
    const fromMenu = state.menu;
    state.view = el.dataset.view; state.customFor = null;
    setMenu(false); render(); window.scrollTo(0, 0);
    if (fromMenu) { const main = $('main.view'); main.setAttribute('tabindex', '-1'); main.focus({ preventScroll: true }); }
  },
  menu() { setMenu(!state.menu); },
  menuclose() { setMenu(false); },
  async look(el) {
    const { part, key } = el.dataset;
    const need = lookTrophy(part, key);
    if (need && !unlocked(need)) { toast(`Locked. Earn the ${need.name} trophy: ${need.desc.toLowerCase()}.`); return; }
    const look = { ...lookOf(me().look), [part]: key };
    state.data.me.look = look;
    render();
    await api.saveLook(look);
  },
  platform(el) { state.platform = el.dataset.p; render(); },
  pfilter(el) { state.partyFilter = el.dataset.id; render(); },
  custom(el) { state.customFor = state.customFor === el.dataset.s ? null : el.dataset.s; render(); const i = $('form[data-form="custom"] input'); if (i) i.focus(); },

  async toggle(el) {
    const mine = mySession();
    // There is no sign-off: once you're on, it simply runs out after an hour.
    if (mine) { toast(`You're on until ${clock(endsAt(mine))}`); return; }
    state.animUntil = Date.now() + 1400;       // let the fill animation finish before redrawing
    el.classList.add('on');
    if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
    const s = await api.startSession(state.platform);
    // Show as on straight away, so a second tap before the reload cannot check in again.
    if (!mySession()) {
      state.data.sessions.unshift({ id: s.id, user_id: me().id, username: me().username, platform: state.platform,
        started_at: s.started_at || new Date().toISOString(), look: me().look, responses: [] });
    }
    if (s.is_new !== false) api.notify({ type: 'session', session_id: s.id }).catch(() => toast('You are on, but the notification did not send'));
    scheduleRefresh();
  },
  async reply(el) {
    await sendReply(el.dataset.s, el.dataset.t);
  },
  // First tap on a slot only shows who is in. A second tap on the same slot, or the button, changes your answer.
  async avail(el) {
    const { day, slot } = el.dataset;
    if (state.cell !== `${day}|${slot}`) { state.cell = `${day}|${slot}`; render(); return; }
    await api.setAvailability(day, slot, !el.classList.contains('mine'));
    await refresh();
  },
  async availset(el) {
    await api.setAvailability(el.dataset.day, el.dataset.slot, !!el.dataset.on);
    await refresh();
  },
  async answer(el) {
    await api.answerRequest(el.dataset.id, !!el.dataset.ok);
    toast(el.dataset.ok ? 'Added to the party' : 'Request declined');
    await refresh();
  },
  async request(el) {
    const r = await api.requestJoin(el.dataset.id);
    api.notify({ type: 'request', request_id: r.id }).catch(() => {});
    toast('Request sent');
    await refresh();
  },
  async leave(el) {
    const party = state.data.parties.find((p) => p.id === el.dataset.id);
    const owner = party.owner_id === me().id;
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = owner ? 'Delete for everyone?' : 'Sure?'; return; }
    await api.leaveParty(party);
    await refresh();
  },
  async share(el) {
    const party = state.data.parties.find((p) => p.id === el.dataset.id);
    const url = `${location.origin}${location.pathname}?join=${encodeURIComponent(party.code)}`;
    const text = `Join my party "${party.name}" on Game With Me. I'm ${me().username}. Invite code: ${party.code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Game With Me", text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Invite copied'); }
    } catch (_) { /* share sheet dismissed */ }
  },
  async push() { await enablePush(); },
  async test() {
    const res = await api.notify({ type: 'test' });
    toast(res && res.sent ? 'Test sent. It should arrive in a moment.' : 'No device is subscribed yet');
  },
  async install() {
    state.installEvt.prompt();
    await state.installEvt.userChoice;
    state.installEvt = null;
    render();
  },
  async delreply(el) {
    const list = me().custom_replies.filter((_, i) => i !== Number(el.dataset.i));
    await api.saveCustomReplies(list);
    await refresh();
  },
  async signout() {
    await api.signOut();
    state.authed = false; state.data = null; state.view = 'home'; state.menu = false;
    render();
  }
};

async function sendReply(sessionId, text) {
  await api.respond(sessionId, text);
  api.notify({ type: 'response', session_id: sessionId }).catch(() => {});
  state.customFor = null;
  toast('Sent');
  await refresh();
}

async function addCustomReply(text) {
  const list = me().custom_replies;
  if (DEFAULT_REPLIES.includes(text) || list.includes(text)) return;
  await api.saveCustomReplies([...list, text].slice(-8));
}

const forms = {
  async auth(f) {
    const username = f.username.value.trim();
    if (!USERNAME_RE.test(username)) throw new Error('Usernames are 3 to 20 letters, numbers or underscores');
    await (state.authMode === 'signup' ? api.signUp(username, f.password.value) : api.signIn(username, f.password.value));
    await enter();
  },
  async custom(f) {
    const text = f.text.value.trim();
    if (!text) return;
    await addCustomReply(text);
    await sendReply(f.dataset.s, text);
  },
  async addreply(f) {
    const text = f.text.value.trim();
    if (!text) return;
    f.text.value = '';
    await addCustomReply(text);
    await refresh();
  },
  async search(f) {
    state.search = await api.searchUsers(f.q.value.trim());
    f.q.blur();
    render();
  },
  async code(f) {
    const code = f.code.value.trim().toUpperCase();
    f.code.value = '';
    await api.joinByCode(code);
    toast('You are in');
    await refresh();
  },
  async party(f) {
    const name = f.name.value.trim();
    if (!name) return;
    f.name.value = '';
    await api.createParty(name);
    await refresh();
  }
};

// A button is ignored while its previous tap is still being dealt with (stops double taps).
const inFlight = new Set();
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const key = JSON.stringify(el.dataset);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try { await actions[el.dataset.act](el); } catch (err) { console.error(err); toast(err.message || 'Something went wrong'); scheduleRefresh(); }
  inFlight.delete(key);
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button');
  if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f); } catch (err) { console.error(err); toast(err.message || 'Something went wrong'); }
  if (btn) btn.disabled = false;
});

/* =====================================================================
   STARTUP
   ===================================================================== */
async function enter() {
  state.authed = true;
  state.data = await api.load();
  // An invite link (?join=CODE) opened before signing in is honoured now.
  const code = store.get('wg-join');
  if (code) {
    store.del('wg-join');
    try { await api.joinByCode(code); toast('You joined the party'); state.data = await api.load(); state.view = 'party'; }
    catch (err) { toast(err.message || 'That invite code did not work'); }
  }
  announceTrophies();
  await checkPush();
  render();
  api.onChange(scheduleRefresh);
}

async function boot() {
  const join = new URLSearchParams(location.search).get('join');
  if (join) { store.set('wg-join', join.toUpperCase()); history.replaceState(null, '', location.pathname); }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; if (state.authed && state.view === 'settings') render(); });
  document.addEventListener('keydown', (e) => {
    if (!state.menu) return;
    if (e.key === 'Escape') { setMenu(false); return; }
    if (e.key !== 'Tab') return;                       // keep Tab inside the open menu
    const stops = [...document.querySelectorAll('.drawer button')];
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
  setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 60000);
  // Every few seconds: shrink the ring, and clear anyone whose hour is up.
  setInterval(() => {
    if (!state.authed || !state.data || document.hidden) return;
    if (state.data.sessions.some(expired)) { refresh(); return; }
    const mine = mySession();
    const ring = $('.pad-btn .ring-left');
    if (mine && ring) ring.style.strokeDashoffset = ringOffset(mine);
  }, 5000);

  try {
    if (await api.init()) await enter(); else render();
  } catch (err) {
    console.error(err);
    $('#app').innerHTML = `<p class="boot">Could not connect. ${esc(err.message || '')}<br><button class="btn" onclick="location.reload()">Try again</button></p>`;
  }
}
boot();
})();
