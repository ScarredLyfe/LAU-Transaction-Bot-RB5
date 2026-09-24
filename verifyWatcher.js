// Auto-verify watcher.
// A person is REGISTERED once their website profile has BOTH a discordId and a robloxId.
// This watcher polls the data server, finds every fully-registered member in the server who
// doesn't yet have the verified role, and grants verified + free-agent roles (removing unverified).
const { db } = require('./database');
const { fetchMembersCached } = require('./memberCache');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const POLL_MS = 20000; // was 8000 -- see note below on why this matters

async function fetchRegisteredDiscordIds() {
  const ids = new Set();
  try {
    const pdb = await (await fetch(`${FB}/data/playerdb.json`)).json();
    if (Array.isArray(pdb)) {
      for (const p of pdb) {
        if (p && String(p.discordId || '').trim() && String(p.robloxId || '').trim()) {
          ids.add(String(p.discordId));
        }
      }
    }
  } catch (e) { console.error('[verify] playerdb fetch failed', e); }

  try {
    const accts = await (await fetch(`${FB}/accounts.json`)).json();
    if (accts && typeof accts === 'object') {
      for (const a of Object.values(accts)) {
        if (a && String(a.discordId || '').trim() && String(a.robloxId || '').trim()) {
          ids.add(String(a.discordId));
        }
      }
    }
  } catch (e) { /* accounts is optional */ }

  return ids;
}

async function grantVerified(guild, settings, discordId, members) {
  // Looked up from the ALREADY-fetched member list (one shared fetch per poll, cached and
  // reused across /sync, /offer, /game_reminder, nameSyncWatcher, and here) instead of a
  // fresh REST call per person. The old version called guild.members.fetch(discordId)
  // separately for every single registered account, every poll -- with hundreds of
  // registered accounts, that was hundreds of Discord API requests every few seconds,
  // competing with every other command for the bot's shared rate-limit budget. Most of
  // those calls were wasted too: almost everyone is already verified and gets skipped right
  // after the fetch, so the expensive part was happening for people there was nothing to do
  // for.
  const member = members.get(discordId);
  if (!member) return false; // not in the server — skip quietly

  if (settings.verified_role_id && member.roles.cache.has(settings.verified_role_id)) return false;

  console.log(`[verify] ${member.user.tag} is registered but not verified — granting roles`);

  const toAdd = [];
  if (settings.verified_role_id)   toAdd.push(settings.verified_role_id);
  if (settings.free_agent_role_id) toAdd.push(settings.free_agent_role_id);
  try { if (toAdd.length) await member.roles.add(toAdd, 'Registered on website'); }
  catch (e) { console.error('[verify] add roles failed (check Manage Roles + role position)', e); return false; }

  try {
    if (settings.unverified_role_id && member.roles.cache.has(settings.unverified_role_id)) {
      await member.roles.remove(settings.unverified_role_id, 'Verified');
    }
  } catch (e) { console.error('[verify] remove unverified failed', e); }

  try { await member.send('✅ You\'re verified! You now have access to the rest of the server.'); } catch (e) {}
  console.log(`[verify] verified ${member.user.tag}`);
  return true;
}

async function poll(client) {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId) return;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
    if (!settings || !settings.verified_role_id) {
      console.log('[verify] SKIP: no verified_role_id set — run /set_verified_role in the server');
      return;
    }

    const registered = await fetchRegisteredDiscordIds();
    const members = await fetchMembersCached(guild).catch(() => guild.members.cache);
    let grantedCount = 0;
    for (const discordId of registered) {
      try {
        const r = await grantVerified(guild, settings, discordId, members);
        if (r) grantedCount++;
      }
      catch (e) { console.error('[verify] grant failed for ' + discordId, e); }
    }
    // Only log when there's something worth reporting -- logging "358 found" every single
    // cycle forever, whether or not anything changed, was mostly just noise.
    if (grantedCount > 0) {
      console.log(`[verify] poll: granted roles to ${grantedCount} newly-registered member(s) out of ${registered.size} total registered`);
    }
  } catch (e) { console.error('[verify] poll error', e); }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[verify] verify watcher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start };