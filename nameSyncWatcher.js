// Keeps every registered player's website display name matched to their ACTUAL current
// Discord server nickname, automatically and continuously -- no admin action needed.
//
// Also resolves "pending claim" stat rows: when a game gets stats entered for someone who
// doesn't have a website account yet, the admin can add them by Discord ID from the Stats &
// Score editor's off-roster modal (optionally with an interim name and Roblox ID for their
// avatar). That creates a row keyed "discord:<id>" instead of a real Roblox name. This
// watcher checks, on the same poll, whether that Discord ID has since registered -- and if
// so, rewrites the row to their real name automatically, everywhere it appears across every
// game they were added to. Nothing further needs to happen on anyone's part once the admin
// adds them.
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

// Same season-resolution rule the rest of the bot's website sync already uses: an explicitly
// active season wins; otherwise fall back to the site's currentSeasonId.
async function activeSeasonId() {
  let seasons = null, currentId = null;
  try { seasons = await (await fetch(`${FB}/data/seasons.json`)).json(); } catch {}
  try { currentId = await (await fetch(`${FB}/data/currentSeasonId.json`)).json(); } catch {}
  if (Array.isArray(seasons)) {
    const active = seasons.find(s => s && s.status === 'active');
    if (active && active.id != null) return active.id;
  }
  return currentId;
}

// Rewrites any "discord:<id>" pending-claim row to the real name, in place, for every game
// it appears in. Returns only the keys that actually changed, so the caller can PATCH just
// those -- never the whole stats object -- and leave everything else completely untouched.
function resolvePendingClaims(statsRows, playerdb) {
  const nameByDiscordId = new Map();
  (playerdb || []).forEach(p => { if (p && p.discordId && p.name) nameByDiscordId.set(String(p.discordId), p.name); });

  const changedKeys = {};
  Object.entries(statsRows || {}).forEach(([key, rows]) => {
    if (!Array.isArray(rows)) return;
    let rowChanged = false;
    const newRows = rows.map(r => {
      if (!r || !r.pendingClaim || !r.discordId) return r;
      const realName = nameByDiscordId.get(String(r.discordId));
      if (!realName) return r; // still hasn't registered -- leave pending
      rowChanged = true;
      const copy = Object.assign({}, r);
      copy.name = realName;
      delete copy.pendingClaim;
      // The interim name/avatar were only ever a stand-in for display -- once resolved, the
      // real playerdb name (and everywhere that looks up avatars by name) takes over, so
      // these no longer serve any purpose and are dropped to keep the row clean.
      delete copy.interimName;
      delete copy.interimRobloxId;
      return copy;
    });
    if (rowChanged) changedKeys[key] = newRows;
  });
  return changedKeys;
}

async function resolvePendingClaimsForActiveSeason(playerdb) {
  try {
    const sid = await activeSeasonId();
    if (sid == null) return;

    const statsRows = await fetch(`${FB}/seasons/${sid}/stats.json`).then(r => r.json()).catch(() => null);
    if (!statsRows || typeof statsRows !== 'object') return;

    const changedKeys = resolvePendingClaims(statsRows, playerdb);
    if (Object.keys(changedKeys).length === 0) return;

    // Narrow PATCH at the "stats" sub-path in BOTH places the site stores this season's
    // data, mirroring exactly what the site's own save does -- so only the resolved rows
    // change, nothing else in either document is touched.
    await Promise.all([
      fetch(`${FB}/seasons/${sid}/stats.json`, { method: 'PATCH', headers: writeHeaders(), body: JSON.stringify(changedKeys) }),
      fetch(`${FB}/data/season_${sid}/stats.json`, { method: 'PATCH', headers: writeHeaders(), body: JSON.stringify(changedKeys) }),
    ]);
    console.log(`[namesync] resolved ${Object.keys(changedKeys).length} pending-claim stat row group(s) for season ${sid}`);
  } catch (e) { console.error('[namesync] pending-claim resolve error', e); }
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

    // Resolve any pending-claim stat rows now that playerdb is current for this poll.
    await resolvePendingClaimsForActiveSeason(playerdb);
  } catch (e) { console.error('[namesync] poll error', e); }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[namesync] name sync watcher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start, resolvePendingClaims };