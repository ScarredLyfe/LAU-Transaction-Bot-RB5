const { db } = require('./database');
const { removePlayerFromWebsiteRoster } = require('./firebaseSync');

// Strips a member's team + signed + coach/owner roles, adds the free agent role,
// clears their team on the roster (keeps the player row so demand counts persist),
// AND removes them from the website roster — because becoming a free agent IS being
// removed from the website roster. Every path that frees a player (/demand, /release,
// /disband) goes through here, so the website stays in sync automatically.
async function makeFreeAgent(guild, member, settings, teamRoleId, teamName) {
  // Remove team role
  if (teamRoleId) await member.roles.remove(teamRoleId).catch(() => {});
  // Remove signed role
  if (settings.signed_role_id) await member.roles.remove(settings.signed_role_id).catch(() => {});

  // Remove any coach/owner roles for this guild.
  // NOTE: this only knows about role IDs registered via /set_coaches. If that table is
  // empty, there is nothing to strip and a departing coach silently keeps their role —
  // so log loudly rather than failing quietly.
  const coachRoles = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ?').all(guild.id);
  if (!coachRoles.length) {
    console.warn(`[freeAgent] no coach roles configured for guild ${guild.id} — run /set_coaches so owner/coach roles get stripped on demand/release`);
  }
  for (const { role_id } of coachRoles) {
    if (member.roles.cache.has(role_id)) await member.roles.remove(role_id).catch(() => {});
  }

  // Clear any staff slot this member held on ANY team in this guild.
  // Removing the Discord role alone was not enough: /release decides who is allowed to
  // release players by reading teams.owner_id / coach1_id / coach2_id, so a coach who
  // demanded out kept the power to release players from the team they just left. It also
  // meant re-signing them later silently restored their old coach slot.
  const staffTeams = db.prepare(
    'SELECT id, name, owner_id, coach1_id, coach2_id FROM teams WHERE guild_id = ? AND (owner_id = ? OR coach1_id = ? OR coach2_id = ?)'
  ).all(guild.id, member.id, member.id, member.id);

  for (const t of staffTeams) {
    if (t.owner_id  === member.id) db.prepare('UPDATE teams SET owner_id  = NULL WHERE id = ?').run(t.id);
    if (t.coach1_id === member.id) db.prepare('UPDATE teams SET coach1_id = NULL WHERE id = ?').run(t.id);
    if (t.coach2_id === member.id) db.prepare('UPDATE teams SET coach2_id = NULL WHERE id = ?').run(t.id);
    console.log(`[freeAgent] cleared staff slot(s) for ${member.id} on ${t.name}`);
  }

  // Add free agent role
  if (settings.free_agent_role_id) await member.roles.add(settings.free_agent_role_id).catch(() => {});
  // Clear their team in the database (keep the row so demands_used persists)
  db.prepare('UPDATE players SET team_id = NULL WHERE guild_id = ? AND user_id = ?')
    .run(guild.id, member.id);

  // Remove them from the website roster (free agent = off the website roster).
  // This also clears their owner/gm/hc entry in the site's staffRoles.
  // Guarded by season lock inside firebaseSync, so it safely no-ops on a locked season.
  await removePlayerFromWebsiteRoster(teamName || null, member.id).catch(() => {});
}

module.exports = { makeFreeAgent };