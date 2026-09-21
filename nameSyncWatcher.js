const { db } = require('./database');
const { fetchMembersCached } = require('./memberCache');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const DATA_KEY = process.env.DATA_API_KEY || '';
const POLL_MS = 90 * 1000;

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

      if (!p.discordId && p.robloxId) {
        const did = discordIdByRoblox.get(String(p.robloxId));
        if (did) { p.discordId = did; changed = true; }
      }
      if (!p.discordId) continue;

      const member = members.get(p.discordId);
      if (!member) continue;

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