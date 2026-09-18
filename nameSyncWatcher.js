// Keeps every registered player's website display name matched to their ACTUAL current
// Discord server nickname, automatically and continuously -- no admin action needed.
//
// Why this exists: the bot already updates a display name the moment someone's nickname
// CHANGES (see the GuildMemberUpdate listener in index.js). But that only fires on a change
// -- if someone registers on the website while their nickname was already set beforehand,
// nothing ever "changes", so that listener never fires for them. And a playerdb row created
// before someone had linked Discord has no discordId on it at all, so there's nothing to
// even watch. Previously the only thing that caught both of those was an admin manually
// running /sync. This watcher does the same two things on its own, on a timer, so names
// stay correct without anyone having to remember to run anything.
const { db } = require('./database');
const { fetchMembersCached } = require('./memberCache');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const DATA_KEY = process.env.DATA_API_KEY || '';
const POLL_MS = 90 * 1000; // every 90s -- frequent enough to feel instant, gentle on the API

function writeHeaders(){
  const h = { 'Content-Type': 'application/json' };
  if (DATA_KEY) h['X-Api-Key'] = DATA_KEY;
  return h;
}

async function poll(client) {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId) return;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const [playerdb, accounts] = await Promise.all([
      fetch(`${FB}/data/playerdb.json`).then(r => r.json()).catch(() => null),
      fetch(`${FB}/accounts.json`).then(r => r.json()).catch(() => null),
    ]);
    if (!Array.isArray(playerdb)) return;

    // robloxId -> discordId, for backfilling rows that link to an account but never got
    // their discordId copied onto the playerdb row itself.
    const discordIdByRoblox = new Map();
    if (accounts && typeof accounts === 'object') {
      for (const a of Object.values(accounts)) {
        if (a && a.robloxId && a.discordId) discordIdByRoblox.set(String(a.robloxId), String(a.discordId));
      }
    }

    const members = await fetchMembersCached(guild).catch(() => guild.members.cache);

    let changed = false;
    for (const p of playerdb) {
      if (!p) continue;

      // Backfill a missing discordId from the matching account, same as /sync does.
      if (!p.discordId && p.robloxId) {
        const did = discordIdByRoblox.get(String(p.robloxId));
        if (did) { p.discordId = did; changed = true; }
      }
      if (!p.discordId) continue;

      const member = members.get(p.discordId);
      if (!member) continue; // not in the server (or intents/cache miss) -- nothing to do

      const currentNick = member.nickname || member.user.globalName || member.user.username || null;
      if (currentNick && p.displayName !== currentNick) {
        p.displayName = currentNick;
        changed = true;
      }
    }

    if (changed) {
      await fetch(`${FB}/data/playerdb.json`, {
        method: 'PUT', headers: writeHeaders(), body: JSON.stringify(playerdb),
      });
      console.log('[namesync] updated playerdb display names / discordId links');
    }
  } catch (e) { console.error('[namesync] poll error', e); }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[namesync] name sync watcher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start };