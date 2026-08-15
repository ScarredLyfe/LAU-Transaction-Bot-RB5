// Pushes signings + coach roles + display names to the website's Firebase.
// Rosters:      rosters/season_<id>/rosters[ABBR] = [names]
// Coaches:      rosters/season_<id>/staffRoles[ABBR] = { owner:{name,role}, gm:{...}, hc:{...} }
// Display name: data/playerdb[i].displayName = Discord server nickname
// Season status: data/seasonMeta = [{id, status}]. Bot only writes to the ACTIVE season,
//                and NEVER writes to a season whose status is 'finished' (locked).
//
// This file is what links the Discord bot to the website. It targets the SAME Firebase
// database the website uses. If you move the site to a different Firebase project, change
// FIREBASE_URL (env) or the fallback below.

const FB = (process.env.FIREBASE_URL || 'https://lau-website-default-rtdb.firebaseio.com').replace(/\/+$/, '');

// Look up a player's website name (their Roblox name in playerdb) from their Discord ID.
async function nameFromDiscordId(discordId) {
  try {
    const res = await fetch(`${FB}/data/playerdb.json`);
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;
    const hit = arr.find(p => p && String(p.discordId || '') === String(discordId));
    return hit ? (hit.name || null) : null;
  } catch (e) { console.error('[sync] playerdb fetch failed', e); return null; }
}

// Map a Discord team name to its website abbreviation via data/team_defs.
async function abbrFromTeamName(teamName) {
  try {
    const res = await fetch(`${FB}/data/team_defs.json`);
    const defs = await res.json();
    if (!Array.isArray(defs)) return null;
    const nm = String(teamName || '').toLowerCase();
    const hit = defs.find(t => t && String(t.name || '').toLowerCase() === nm);
    return hit ? hit.abbr : null;
  } catch (e) { console.error('[sync] team_defs fetch failed', e); return null; }
}

// The ONLY season the bot may write to is the one explicitly labeled 'active' in
// data/seasonMeta. If no season is marked active, this returns null and the bot writes
// nowhere — it never guesses or falls back to another season. This guarantees the bot
// can never touch a locked/finished season, or an upcoming/unlabeled one.
async function activeSeasonId() {
  try {
    const res = await fetch(`${FB}/data/seasonMeta.json`);
    const meta = await res.json();
    if (Array.isArray(meta)) {
      const a = meta.find(s => s && s.status === 'active');
      if (a && a.id != null) return a.id;
    }
  } catch (e) { console.error('[sync] seasonMeta fetch failed', e); }
  return null; // no active season → do not write
}

async function loadSeasonRosters(sid) {
  try { const res = await fetch(`${FB}/rosters/season_${sid}.json`); const obj = await res.json(); if (obj && typeof obj === 'object') return obj; } catch {}
  return {};
}
async function saveSeasonRosters(sid, obj) {
  await fetch(`${FB}/rosters/season_${sid}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
}

// Add a player to a team's website roster (and remove them from any other team's roster first).
async function addPlayerToWebsiteRoster(teamName, discordId) {
  const sid = await activeSeasonId();
  if (sid == null) { console.log('[sync] SKIP add: no active season — bot writes nowhere'); return { ok: false }; }
  const [playerName, abbr] = await Promise.all([ nameFromDiscordId(discordId), abbrFromTeamName(teamName) ]);
  console.log(`[sync] add: discordId=${discordId} team="${teamName}" -> name=${playerName} abbr=${abbr} season=${sid}`);
  if (!playerName) { console.log('[sync] SKIP: no playerdb profile with that discordId'); return { ok: false }; }
  if (!abbr) { console.log('[sync] SKIP: no team_defs abbr matches that team name'); return { ok: false }; }

  const season = await loadSeasonRosters(sid);
  if (!season.rosters || typeof season.rosters !== 'object') season.rosters = {};
  for (const t of Object.keys(season.rosters))
    if (Array.isArray(season.rosters[t])) season.rosters[t] = season.rosters[t].filter(n => String(n || '').toLowerCase() !== playerName.toLowerCase());
  if (!Array.isArray(season.rosters[abbr])) season.rosters[abbr] = [];
  if (!season.rosters[abbr].some(n => String(n || '').toLowerCase() === playerName.toLowerCase())) season.rosters[abbr].push(playerName);

  await saveSeasonRosters(sid, season);
  console.log(`[sync] WROTE ${playerName} to ${abbr}`);
  return { ok: true, playerName, abbr };
}

// Remove a player from every team's website roster AND clear any staff slot they held.
// (Becoming a free agent = being removed from the website roster.)
async function removePlayerFromWebsiteRoster(teamName, discordId) {
  const sid = await activeSeasonId();
  if (sid == null) { console.log('[sync] SKIP remove: no active season — bot writes nowhere'); return { ok: false }; }
  const playerName = await nameFromDiscordId(discordId);
  if (!playerName) return { ok: false };
  const season = await loadSeasonRosters(sid);
  if (!season.rosters) return { ok: true };
  let changed = false;
  for (const t of Object.keys(season.rosters)) if (Array.isArray(season.rosters[t])) {
    const b = season.rosters[t].length;
    season.rosters[t] = season.rosters[t].filter(n => String(n || '').toLowerCase() !== playerName.toLowerCase());
    if (season.rosters[t].length !== b) changed = true;
  }
  if (season.staffRoles) {
    for (const ab of Object.keys(season.staffRoles)) {
      const sr = season.staffRoles[ab] || {};
      for (const slot of ['owner', 'gm', 'hc'])
        if (sr[slot] && String(sr[slot].name || '').toLowerCase() === playerName.toLowerCase()) { delete sr[slot]; changed = true; }
      season.staffRoles[ab] = sr;
    }
  }
  if (changed) { await saveSeasonRosters(sid, season); console.log(`[sync] removed ${playerName}`); }
  return { ok: true };
}

// Set (or clear, when roleName is falsy) a player's staff slot (owner/gm/hc) on a team.
async function setWebsiteStaffRole(teamName, discordId, slot, roleName) {
  const sid = await activeSeasonId();
  if (sid == null) { console.log('[sync] SKIP staff: no active season — bot writes nowhere'); return { ok: false }; }
  const [playerName, abbr] = await Promise.all([ nameFromDiscordId(discordId), abbrFromTeamName(teamName) ]);
  if (!playerName || !abbr) { console.log(`[sync] SKIP staff: name=${playerName} abbr=${abbr}`); return { ok: false }; }

  const season = await loadSeasonRosters(sid);
  if (!season.staffRoles || typeof season.staffRoles !== 'object') season.staffRoles = {};
  if (!season.staffRoles[abbr]) season.staffRoles[abbr] = {};
  const sr = season.staffRoles[abbr];

  if (roleName) {
    for (const s of ['owner', 'gm', 'hc']) if (sr[s] && String(sr[s].name || '').toLowerCase() === playerName.toLowerCase()) delete sr[s];
    sr[slot] = { name: playerName, role: roleName };
    console.log(`[sync] staff SET ${playerName} = ${slot} (${roleName}) on ${abbr}`);
  } else {
    if (sr[slot] && String(sr[slot].name || '').toLowerCase() === playerName.toLowerCase()) delete sr[slot];
    console.log(`[sync] staff CLEAR ${playerName} from ${slot} on ${abbr}`);
  }
  season.staffRoles[abbr] = sr;
  await saveSeasonRosters(sid, season);
  return { ok: true };
}

// Write a player's Discord server nickname to playerdb as displayName, so the website shows
// their Discord name. Priority: server nickname → global display name → username.
// This is a label-only update: it is allowed even on finished/locked seasons because it
// changes how a name is displayed, not who is on a roster.
async function setWebsiteDisplayName(discordId, member) {
  try {
    const name = (member && (member.nickname || (member.user && member.user.globalName) || (member.user && member.user.username))) || null;
    if (!name) return { ok: false };
    const res = await fetch(`${FB}/data/playerdb.json`);
    const arr = await res.json();
    if (!Array.isArray(arr)) return { ok: false };
    const idx = arr.findIndex(p => p && String(p.discordId || '') === String(discordId));
    if (idx < 0) { console.log(`[sync] displayName: no playerdb entry for ${discordId}`); return { ok: false }; }
    if (arr[idx].displayName === name) return { ok: true };
    arr[idx].displayName = name;
    await fetch(`${FB}/data/playerdb.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arr),
    });
    console.log(`[sync] displayName set: ${discordId} -> "${name}"`);
    return { ok: true, name };
  } catch (e) { console.error('[sync] setWebsiteDisplayName failed', e); return { ok: false }; }
}

module.exports = {
  addPlayerToWebsiteRoster,
  removePlayerFromWebsiteRoster,
  setWebsiteStaffRole,
  setWebsiteDisplayName,
};
