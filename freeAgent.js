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
  // Remove any coach/owner roles for this guild
  const coachRoles = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ?').all(guild.id);
  for (const { role_id } of coachRoles) {
    if (member.roles.cache.has(role_id)) await member.roles.remove(role_id).catch(() => {});
  }
  // Add free agent role
  if (settings.free_agent_role_id) await member.roles.add(settings.free_agent_role_id).catch(() => {});
  // Clear their team in the database (keep the row so demands_used persists)
  db.prepare('UPDATE players SET team_id = NULL WHERE guild_id = ? AND user_id = ?')
    .run(guild.id, member.id);

  // Remove them from the website roster (free agent = off the website roster).
  // Guarded by season lock inside firebaseSync, so it safely no-ops on a locked season.
  await removePlayerFromWebsiteRoster(teamName || null, member.id).catch(() => {});
}

module.exports = { makeFreeAgent };
