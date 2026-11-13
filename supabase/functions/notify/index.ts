// Game With Me - "notify" edge function.
// The app calls this after something happens; it works out who should hear about it
// and sends a Web Push to each of their phones.
//
// It cannot be replayed: each check-in and join request is announced once, and a reply
// is announced only when its text changes (3 times at most). The claim is recorded in
// the database before anything is sent.
//
// Secrets it needs (Supabase > Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Payload = { title: string; body: string; tag: string };
const MAX_REPLY_PUSHES = 3;

async function partyMates(userId: string): Promise<string[]> {
  const { data: mine } = await admin.from("party_members").select("party_id").eq("user_id", userId);
  const ids = (mine ?? []).map((r) => r.party_id);
  if (!ids.length) return [];
  const { data: all } = await admin.from("party_members").select("user_id").in("party_id", ids);
  return [...new Set((all ?? []).map((r) => r.user_id))].filter((id) => id !== userId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const pub = Deno.env.get("VAPID_PUBLIC_KEY");
    const priv = Deno.env.get("VAPID_PRIVATE_KEY");
    const subject = Deno.env.get("VAPID_SUBJECT");
    if (!pub || !priv || !subject) return json({ error: "VAPID secrets are not set on this function" }, 500);
    webpush.setVapidDetails(subject, pub, priv);

    // Who is calling? The app sends the signed-in user's token.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (!user) return json({ error: "Not signed in" }, 401);

    const body = await req.json();
    const { data: me } = await admin.from("profiles").select("username").eq("id", user.id).single();
    const name = me?.username ?? "Someone";

    let recipients: string[] = [];
    let payload: Payload;

    if (body.type === "test") {
      recipients = [user.id];
      payload = { title: "Notifications are working", body: `You're all set, ${name}.`, tag: "test" };
    } else if (body.type === "session") {
      // Claim the announcement: only the first call for a check-in from the last hour gets through.
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: s } = await admin.from("sessions")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", body.session_id).eq("user_id", user.id).is("notified_at", null).gt("started_at", hourAgo)
        .select("id,platform").maybeSingle();
      if (!s) return json({ sent: 0, failed: 0, skipped: "already announced" });
      recipients = await partyMates(user.id);
      payload = {
        title: `${name} is gaming`,
        body: `On ${s.platform}. Tap to reply.`,
        tag: `session-${s.id}`,
      };
    } else if (body.type === "response") {
      const { data: r } = await admin.from("responses").select("text,notified_text,notify_count,sessions(user_id)")
        .eq("session_id", body.session_id).eq("user_id", user.id).maybeSingle();
      // deno-lint-ignore no-explicit-any
      const host = (r as any)?.sessions?.user_id;
      if (!r || !host) return json({ error: "Reply not found" }, 404);
      // Tell the host once per change of reply, and at most 3 times per check-in.
      if (r.text === r.notified_text || r.notify_count >= MAX_REPLY_PUSHES || host === user.id) {
        return json({ sent: 0, failed: 0, skipped: "already told" });
      }
      const { data: claimed } = await admin.from("responses")
        .update({ notified_text: r.text, notify_count: r.notify_count + 1 })
        .eq("session_id", body.session_id).eq("user_id", user.id).eq("notify_count", r.notify_count)
        .select("text").maybeSingle();
      if (!claimed) return json({ sent: 0, failed: 0, skipped: "already told" });
      recipients = [host];
      payload = { title: `${name}: ${r.text}`, body: "Replying to your check-in", tag: `reply-${body.session_id}-${user.id}` };
    } else if (body.type === "request") {
      const { data: r } = await admin.from("join_requests")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", body.request_id).eq("user_id", user.id).is("notified_at", null)
        .select("user_id,parties(name,owner_id)").maybeSingle();
      // deno-lint-ignore no-explicit-any
      const party = (r as any)?.parties;
      if (!r || !party) return json({ sent: 0, failed: 0, skipped: "already sent" });
      recipients = [party.owner_id];
      payload = { title: `${name} wants to join ${party.name}`, body: "Open the Party tab to accept.", tag: `request-${body.request_id}` };
    } else {
      return json({ error: "Unknown type" }, 400);
    }

    if (!recipients.length) return json({ sent: 0, failed: 0 });
    const { data: subs } = await admin.from("push_subscriptions").select("endpoint,p256dh,auth").in("user_id", recipients);

    let sent = 0, failed = 0;
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "high" },
        );
        sent++;
      } catch (err) {
        failed++;
        // deno-lint-ignore no-explicit-any
        const status = (err as any)?.statusCode;
        console.error("push failed", status, (err as Error)?.message);
        // 404 / 410 mean the phone has unsubscribed: forget it.
        if (status === 404 || status === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }));
    return json({ sent, failed });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
