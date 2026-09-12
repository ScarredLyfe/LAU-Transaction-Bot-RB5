// Caches guild member fetches so repeated roster/lookup commands don't re-fetch the whole
// member list every time. Falls back to a fresh fetch when the cache is stale.
const _cache = new Map(); // guildId -> { at, members }

async function fetchMembersCached(guild, ttlMs = 60000) {
  const hit = _cache.get(guild.id);
  if (hit && (Date.now() - hit.at) < ttlMs) return hit.members;
  const members = await guild.members.fetch();
  _cache.set(guild.id, { at: Date.now(), members });
  return members;
}

module.exports = { fetchMembersCached };