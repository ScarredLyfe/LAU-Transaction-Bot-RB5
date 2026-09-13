// Pushes signings + coach roles + display names to the website's Firebase.
// Rosters:      rosters/season_<id>/rosters[ABBR] = [names]
// Coaches:      rosters/season_<id>/staffRoles[ABBR] = { owner:{name,role}, gm:{...}, hc:{...} }
// Display name: data/playerdb[i].displayName = Discord server nickname
//
// This file is what links the Discord bot to the website. It targets the SAME Firebase
// database the website uses. If you move the site to a different Firebase project, change
// FIREBASE_URL (env) or the fallback below.

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const DATA_KEY = process.env.DATA_API_KEY || '';
const _wHdr = (h) => Object.assign({ 'Content-Type': 'application/json' }, DATA_KEY ? { 'X-Api-Key': DATA_KEY } : {}, h || {});

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

// The season the bot writes to. This site stores the current season as
// data/currentSeasonId, and the season list (with status) as data/seasons = [{id,name,status}].
// (Older builds used data/seasonMeta / data/defaultSeasonId — still honored as a fallback.)
// A season is a valid write target unless it is explicitly status:'finished' (locked).
async function activeSeasonId() {
  // Primary: this site's real fields.
  let seasons = null, currentId = null;
  try { seasons = await (await fetch(`${FB}/data/seasons.json`)).json(); } catch {}
  try { currentId = await (await fetch(`${FB}/data/currentSeasonId.json`)).json(); } catch {}

  const statusOf = (id) => {
    if (Array.isArray(seasons)) {
      const s = seasons.find(x => x && String(x.id) === String(id));
      return s ? (s.status || null) : null;
    }
    return null;
  };

  // 1) An explicitly-active season in data/seasons wins.
  if (Array.isArray(seasons)) {
    const a = seasons.find(s => s && s.status === 'active');
    if (a && a.id != null) return a.id;
  }
  // 2) The current season, unless it's explicitly finished (locked).
  if (currentId != null && statusOf(currentId) !== 'finished') return currentId;

  // 3) Legacy fallback: older data/seasonMeta + data/defaultSeasonId layout.
  let meta = null;
  try { meta = await (await fetch(`${FB}/data/seasonMeta.json`)).json(); } catch {}
  if (Array.isArray(meta)) {
    const a = meta.find(s => s && s.status === 'active');
    if (a && a.id != null) return a.id;
  }
  try {
    const def = await (await fetch(`${FB}/data/defaultSeasonId.json`)).json();
    if (def != null) {
      const e = Array.isArray(meta) ? meta.find(s => s && String(s.id) === String(def)) : null;
      if (!e || e.status !== 'finished') return def;
    }
  } catch {}

  return null; // nothing usable → do not write
}

async function loadSeasonRosters(sid) {
  try { const res = await fetch(`${FB}/rosters/season_${sid}.json`); const obj = await res.json(); if (obj && typeof obj === 'object') return obj; } catch {}
  return {};
}
async function saveSeasonRosters(sid, obj) {
  await fetch(`${FB}/rosters/season_${sid}.json`, { method: 'PUT', headers: _wHdr(), body: JSON.stringify(obj) });
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
      method: 'PUT', headers: _wHdr(), body: JSON.stringify(arr),
    });
    console.log(`[sync] displayName set: ${discordId} -> "${name}"`);
    return { ok: true, name };
  } catch (e) { console.error('[sync] setWebsiteDisplayName failed', e); return { ok: false }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK SYNC
//
// The per-player helpers above each re-resolve the season, re-download playerdb and
// team_defs, then read-modify-write the whole season object. That's ~6 HTTP round-trips
// PER PLAYER, and /sync calls them in a sequential loop for every rostered member, every
// staff member, and every nickname. On a mid-size server that's 1,000+ sequential requests
// taking several minutes — long enough that the Discord interaction token expires and the
// final editReply fails with "Unknown Webhook", so the command appears to do nothing even
// while it's still churning in the background.
//
// This does the same work with a fixed ~6 requests total, regardless of member count:
// read each source once, compute the entire result in memory, write each destination once.
// ─────────────────────────────────────────────────────────────────────────────
async function bulkSyncToWebsite({ rosterJobs = [], staffJobs = [], nameJobs = [] }) {
  const result = {
    ok: false, reason: null,
    seasonId: null, rostered: 0, staff: 0, names: 0,
    unregistered: [], noProfile: [], unknownTeams: [],
  };

  const sid = await activeSeasonId();
  if (sid == null) {
    result.reason = 'no-active-season';
    console.log('[sync] ABORT bulk: no active season — bot writes nowhere');
    return result;
  }
  result.seasonId = sid;

  // ── Read every source exactly once ──
  let playerdb = null, teamDefs = null, season = null, accounts = null;
  try { playerdb = await (await fetch(`${FB}/data/playerdb.json`)).json(); } catch (e) { console.error('[sync] playerdb fetch failed', e); }
  try { teamDefs = await (await fetch(`${FB}/data/team_defs.json`)).json(); } catch (e) { console.error('[sync] team_defs fetch failed', e); }
  try { season   = await loadSeasonRosters(sid); } catch (e) { console.error('[sync] season fetch failed', e); }
  // accounts.json is the other place a linked account can live. A player counts as
  // registered only if they have a robloxId actually attached -- a half-finished entry
  // with a discordId and no robloxId can't be matched to anything on the site.
  try { accounts = await (await fetch(`${FB}/accounts.json`)).json(); } catch (e) { console.error('[sync] accounts fetch failed', e); }

  if (!Array.isArray(playerdb)) { result.reason = 'playerdb-unavailable'; return result; }
  if (!Array.isArray(teamDefs)) { result.reason = 'team-defs-unavailable'; return result; }
  season = (season && typeof season === 'object') ? season : {};

  // ── Build in-memory lookups ──
  // Map Discord ID -> player name. If the same Discord ID appears on more than one row
  // (which happens when someone unlinks and relinks and the old row wasn't cleared), prefer
  // the row that actually has a robloxId — a row with no Roblox link can't be matched to
  // anything on the site anyway. Plain last-write-wins would pick whichever happened to sit
  // later in the array, which is arbitrary.
  const nameByDiscord = new Map();
  const rowByDiscord = new Map();
  playerdb.forEach(p => {
    if (!p || !p.discordId) return;
    const did = String(p.discordId);
    const prev = rowByDiscord.get(did);
    if (prev) {
      console.warn(`[sync] playerdb has ${did} on more than one row: "${prev.name}" and "${p.name}" — using whichever has a robloxId`);
      const prevLinked = String(prev.robloxId || '').trim();
      const thisLinked = String(p.robloxId || '').trim();
      if (prevLinked && !thisLinked) return;  // keep the existing, better row
    }
    rowByDiscord.set(did, p);
    nameByDiscord.set(did, p.name || null);
  });
  const abbrByTeamName = new Map();
  teamDefs.forEach(t => { if (t && t.name) abbrByTeamName.set(String(t.name).toLowerCase(), t.abbr); });

  // Same definition of "registered" the verify button and the website itself use:
  // a linked entry in EITHER accounts or playerdb that carries a non-empty robloxId.
  const registeredIds = new Set();
  const collect = (o) => {
    if (o && o.discordId && String(o.robloxId || '').trim()) registeredIds.add(String(o.discordId));
  };
  if (accounts && typeof accounts === 'object') Object.values(accounts).forEach(collect);
  if (Array.isArray(playerdb)) playerdb.forEach(collect);

  // ── Rosters: rebuild from scratch for the teams we know about ──
  // Only teams that actually appear in rosterJobs are reset, so a team whose Discord role
  // was deleted (or that nobody currently holds) keeps whatever the site already had
  // rather than being silently emptied.
  const rosters = (season.rosters && typeof season.rosters === 'object') ? season.rosters : {};
  const touchedAbbrs = new Set();
  const resolved = []; // [abbr, playerName, discordId]

  for (const [teamName, discordId] of rosterJobs) {
    const abbr = abbrByTeamName.get(String(teamName || '').toLowerCase());
    if (!abbr) { if (!result.unknownTeams.includes(teamName)) result.unknownTeams.push(teamName); continue; }

    // Anyone holding a team role without a linked website account is flagged here, with the
    // team they're on, so the caller can DM them. Carrying the team name through avoids a
    // second lookup and lets the DM name their team.
    if (!registeredIds.has(String(discordId))) {
      result.unregistered.push({ discordId: String(discordId), teamName });
      continue;
    }

    const playerName = nameByDiscord.get(String(discordId));
    // Registered (has a robloxId) but no playerdb row to read a name from -- nothing to put
    // on the roster, but they don't need a "go register" DM either.
    if (!playerName) { result.noProfile.push(String(discordId)); continue; }

    touchedAbbrs.add(abbr);
    resolved.push([abbr, playerName, discordId]);
  }

  touchedAbbrs.forEach(abbr => { rosters[abbr] = []; });
  const placed = new Set(); // lowercased name -> already placed (a player belongs to one team)
  for (const [abbr, playerName] of resolved) {
    const key = playerName.toLowerCase();
    if (placed.has(key)) continue;
    // A player should never sit on two rosters at once, so drop them from any other team.
    for (const t of Object.keys(rosters)) {
      if (t === abbr || !Array.isArray(rosters[t])) continue;
      rosters[t] = rosters[t].filter(n => String(n || '').toLowerCase() !== key);
    }
    rosters[abbr].push(playerName);
    placed.add(key);
    result.rostered++;
  }
  season.rosters = rosters;

  // ── Staff roles: same idea, reset only the teams we're syncing ──
  const staffRoles = (season.staffRoles && typeof season.staffRoles === 'object') ? season.staffRoles : {};
  touchedAbbrs.forEach(abbr => { staffRoles[abbr] = {}; });
  for (const [teamName, discordId, slot, roleName] of staffJobs) {
    const abbr = abbrByTeamName.get(String(teamName || '').toLowerCase());
    const playerName = nameByDiscord.get(String(discordId));
    if (!abbr || !playerName || !roleName) continue;
    if (!staffRoles[abbr]) staffRoles[abbr] = {};
    const sr = staffRoles[abbr];
    // One person holds one slot per team — clear any other slot they were sitting in.
    for (const s of ['owner', 'gm', 'hc']) {
      if (sr[s] && String(sr[s].name || '').toLowerCase() === playerName.toLowerCase()) delete sr[s];
    }
    sr[slot] = { name: playerName, role: roleName };
    result.staff++;
  }
  season.staffRoles = staffRoles;

  // ── Display names: mutate the array we already have, write it once ──
  let nameChanged = false;

  // BACKFILL: many playerdb rows are Roblox-only (no discordId) even though the person HAS
  // linked Discord — the link lives in the accounts node but was never copied onto the
  // playerdb row. Without a discordId on the row, /sync can't match them and their card keeps
  // showing the Roblox name. So first, copy discordId (+ username/avatar) from accounts onto
  // any playerdb row that's missing it, matching by robloxId. This permanently fixes the row
  // so this and every future sync can find them.
  const acctByRoblox = new Map();   // robloxId -> account object
  const acctByDiscord = new Map();  // discordId -> account object
  if (accounts && typeof accounts === 'object') {
    Object.values(accounts).forEach(a => {
      if (!a) return;
      const rid = String(a.robloxId || '').trim();
      const did = String(a.discordId || '').trim();
      if (rid && did) acctByRoblox.set(rid, a);
      if (did) acctByDiscord.set(did, a);
    });
  }
  playerdb.forEach(p => {
    if (!p) return;
    if (p.discordId) return;                 // already has one
    const rid = String(p.robloxId || '').trim();
    if (!rid) return;
    const acct = acctByRoblox.get(rid);
    if (acct) {
      p.discordId = String(acct.discordId);
      if (acct.discordUsername && !p.discordUsername) p.discordUsername = acct.discordUsername;
      if (acct.discordAvatar && !p.discordAvatar) p.discordAvatar = acct.discordAvatar;
      nameChanged = true;                     // row changed, needs a write
      console.log(`[sync] backfilled discordId ${acct.discordId} onto playerdb row "${p.name}" from accounts`);
    }
  });

  // Now build the discordId -> row index map (AFTER backfill so newly-linked rows are included).
  const idxByDiscord = new Map();
  playerdb.forEach((p, i) => { if (p && p.discordId) idxByDiscord.set(String(p.discordId), i); });
  for (const [discordId, displayName] of nameJobs) {
    if (!displayName) continue;
    const i = idxByDiscord.get(String(discordId));
    if (i == null) continue;               // not registered on the site — nothing to attach to
    if (playerdb[i].displayName === displayName) continue;  // already correct
    playerdb[i].displayName = displayName;
    nameChanged = true;
    result.names++;
  }

  // ── Write each destination exactly once ──
  try {
    await saveSeasonRosters(sid, season);
  } catch (e) {
    console.error('[sync] season write failed', e);
    result.reason = 'season-write-failed';
    return result;
  }
  if (nameChanged) {
    try {
      await fetch(`${FB}/data/playerdb.json`, { method: 'PUT', headers: _wHdr(), body: JSON.stringify(playerdb) });
    } catch (e) {
      console.error('[sync] playerdb write failed', e);
      result.reason = 'playerdb-write-failed';
      return result;
    }
  }

  result.ok = true;
  console.log(`[sync] bulk done: season=${sid} rostered=${result.rostered} staff=${result.staff} names=${result.names}`);
  return result;
}

module.exports = {
  addPlayerToWebsiteRoster,
  removePlayerFromWebsiteRoster,
  setWebsiteStaffRole,
  setWebsiteDisplayName,
  bulkSyncToWebsite,
};