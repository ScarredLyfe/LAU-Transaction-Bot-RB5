// Caches guild member fetches so repeated roster/lookup commands don't re-fetch the whole
// member list every time. Falls back to a fresh fetch when the cache is stale.
const _cache = new Map();   // guildId -> { at, members }
const _inFlight = new Map(); // guildId -> Promise, so two callers hitting a stale cache at
                              // the same moment share ONE fetch instead of both firing their
                              // own -- Discord's gateway strictly rate-limits how often a bot
                              // can request a guild's full member list, and two near-
                              // simultaneous raw fetches was enough to trip that limit.

async function fetchMembersCached(guild, ttlMs = 60000) {
  const hit = _cache.get(guild.id);
  if (hit && (Date.now() - hit.at) < ttlMs) return hit.members;

  const pending = _inFlight.get(guild.id);
  if (pending) return pending;

  const fetchPromise = guild.members.fetch()
    .then(members => {
      _cache.set(guild.id, { at: Date.now(), members });
      return members;
    })
    .finally(() => { _inFlight.delete(guild.id); });

  _inFlight.set(guild.id, fetchPromise);
  return fetchPromise;
}

module.exports = { fetchMembersCached };