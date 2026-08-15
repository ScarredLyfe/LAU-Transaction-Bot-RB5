const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { setWebsiteDisplayName, addPlayerToWebsiteRoster, setWebsiteStaffRole } = require('../firebaseSync');

// coach_1 -> GM slot on the website, coach_2 -> HC slot on the website.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Rebuild rosters from current Discord roles and refresh the website')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    if (teams.length === 0) return interaction.editReply('No teams are registered yet.');

    const ownerRole  = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId)?.role_id;
    const coach1Role = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_1'").get(interaction.guildId)?.role_id;
    const coach2Role = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_2'").get(interaction.guildId)?.role_id;

    // Pull every member (needs the Server Members Intent)
    const members = await interaction.guild.members.fetch();

    // Wipe the old roster + coach records for this guild, then rebuild from roles
    db.prepare('DELETE FROM players WHERE guild_id = ?').run(interaction.guildId);
    for (const team of teams) {
      db.prepare('UPDATE teams SET owner_id = NULL, coach1_id = NULL, coach2_id = NULL WHERE id = ?').run(team.id);
    }

    let playerCount = 0;
    const insertPlayer = db.prepare(
      `INSERT INTO players (guild_id, user_id, team_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id`
    );

    const rosterJobs = [];  // [teamName, discordId]
    const staffJobs = [];   // [teamName, discordId, slot, roleName]

    for (const team of teams) {
      for (const member of members.values()) {
        if (member.user.bot) continue;
        if (!member.roles.cache.has(team.role_id)) continue;

        insertPlayer.run(interaction.guildId, member.id, team.id);
        playerCount++;

        rosterJobs.push([team.name, member.id]);

        if (ownerRole && member.roles.cache.has(ownerRole)) {
          db.prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(member.id, team.id);
          const rn = interaction.guild.roles.cache.get(ownerRole)?.name || 'Owner';
          staffJobs.push([team.name, member.id, 'owner', rn]);
        }
        if (coach1Role && member.roles.cache.has(coach1Role)) {
          db.prepare('UPDATE teams SET coach1_id = ? WHERE id = ?').run(member.id, team.id);
          const rn = interaction.guild.roles.cache.get(coach1Role)?.name || 'Coach 1';
          staffJobs.push([team.name, member.id, 'gm', rn]); // Coach 1 -> GM slot
        }
        if (coach2Role && member.roles.cache.has(coach2Role)) {
          db.prepare('UPDATE teams SET coach2_id = ? WHERE id = ?').run(member.id, team.id);
          const rn = interaction.guild.roles.cache.get(coach2Role)?.name || 'Coach 2';
          staffJobs.push([team.name, member.id, 'hc', rn]); // Coach 2 -> HC slot
        }
      }
    }

    // Push rosters + coach roles to the website (season-lock guarded inside firebaseSync).
    for (const [tName, did] of rosterJobs)          { try { await addPlayerToWebsiteRoster(tName, did); } catch {} }
    for (const [tName, did, slot, rn] of staffJobs) { try { await setWebsiteStaffRole(tName, did, slot, rn); } catch {} }

    // Backfill Discord nicknames for EVERY non-bot member (not just people on teams).
    // setWebsiteDisplayName safely no-ops for anyone with no playerdb entry.
    let nameCount = 0;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      try {
        const r = await setWebsiteDisplayName(member.id, member);
        if (r && r.ok && r.name) nameCount++;
      } catch {}
    }

    await interaction.editReply(
      `✅ Synced ${playerCount} roster spot${playerCount === 1 ? '' : 's'} across ${teams.length} team${teams.length === 1 ? '' : 's'}, ` +
      `refreshed coach roles, and updated ${nameCount} Discord nickname${nameCount === 1 ? '' : 's'} on the website.`
    );
  },
};
