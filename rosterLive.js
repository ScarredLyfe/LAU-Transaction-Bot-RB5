// Live roster helpers: the database can drift from Discord (an admin removes a role by hand,
// someone leaves the server, a role gets swapped), so anything that SHOWS a roster or DECIDES
// whether one is full goes through here and checks the actual Discord roles.
const { db } = require('./database');
const { fetchMembersCached } = require('./memberCache');

const STAFF_COLUMNS = { owner: 'owner_id', coach_1: 'coach1_id', coach_2: 'coach2_id' };

async function getMembers(guild) {
  return fetchMembersCached(guild).catch(() => guild.members.cache);
}

function staffRoleId(guildId, position) {
  const row = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = ?').get(guildId, position);
  return row ? row.role_id : null;
}

// Players on a team's roster: in the database for this team AND still holding the team role.
function liveRosterIds(members, guildId, team) {
  const rows = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(guildId, team.id);
  return rows.map(r => r.user_id).filter(id => {
    const m = members.get(id);
    return m && m.roles.cache.has(team.role_id);
  });
}

// Who actually holds a staff spot (owner = Athletic Director, coach_1, coach_2) on a team:
// someone with BOTH the team role and that staff role. If the saved holder lost the staff role
// (e.g. it was removed by hand), the saved value is corrected: to the one other team member who
// has the role, or to nobody. If two team members hold it, nobody is picked until an admin fixes it.
function liveStaff(members, guildId, team, position) {
  const col = STAFF_COLUMNS[position];
  const roleId = staffRoleId(guildId, position);
  const saved = team[col] || null;
  const onTeam = id => { const m = members.get(id); return !!(m && m.roles.cache.has(team.role_id)); };

  if (!roleId) return saved && onTeam(saved) ? saved : null; // staff role not configured: old behaviour

  const holds = id => { const m = members.get(id); return !!(m && m.roles.cache.has(team.role_id) && m.roles.cache.has(roleId)); };
  if (saved && holds(saved)) return saved;

  const holders = [];
  members.forEach(m => { if (m.roles.cache.has(team.role_id) && m.roles.cache.has(roleId)) holders.push(m.id); });
  const next = holders.length === 1 ? holders[0] : null;
  if (saved !== next) {
    db.prepare(`UPDATE teams SET ${col} = ? WHERE id = ?`).run(next, team.id);
    team[col] = next;
  }
  return next;
}

module.exports = { getMembers, liveRosterIds, liveStaff, staffRoleId };