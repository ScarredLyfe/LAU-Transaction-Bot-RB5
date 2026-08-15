// Auto-verify watcher.
// The website has no "verify_queue" — instead, a person is considered REGISTERED once their
// website profile has BOTH a discordId and a robloxId linked. This watcher polls Firebase,
// finds every fully-registered member who is in the server but doesn't yet have the verified
// role, grants them verified + free-agent roles, and removes the unverified role.
//
// This needs NO changes to the website: registering on the site (linking Discord + Roblox)
// is what flips the switch, and the bot notices within a few seconds.
const { db } = require('./database');

const FB = (process.env.FIREBASE_URL || 'https://lau-website-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const POLL_MS = 8000;

// Collect the Discord IDs of everyone who is fully registered on the website
// (has both a discordId and a robloxId). Checks playerdb first, then accounts as a backup.
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
  } catch (e) { /* accounts is optional; playerdb is the primary source */ }

  return ids;
}

async function grantVerified(guild, settings, discordId) {
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return false;

  // Already verified? Nothing to do (keeps the poll quiet and avoids re-DMing).
  if (settings.verified_role_id && member.roles.cache.has(settings.verified_role_id)) return false;

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
    // Nothing to do until an admin has set at least a verified role.
    if (!settings || !settings.verified_role_id) return;

    const registered = await fetchRegisteredDiscordIds();
    for (const discordId of registered) {
      try { await grantVerified(guild, settings, discordId); }
      catch (e) { console.error('[verify] grant failed', e); }
    }
  } catch (e) { console.error('[verify] poll error', e); }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[verify] verify watcher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start };