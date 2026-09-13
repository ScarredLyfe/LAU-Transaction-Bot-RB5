const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { bulkSyncToWebsite } = require('../firebaseSync');

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

    // Pull every member once (needs the Server Members Intent).
    const members = await interaction.guild.members.fetch();

    // Wipe the old roster + coach records for this guild, then rebuild from roles.
    db.prepare('DELETE FROM players WHERE guild_id = ?').run(interaction.guildId);
    for (const team of teams) {
      db.prepare('UPDATE teams SET owner_id = NULL, coach1_id = NULL, coach2_id = NULL WHERE id = ?').run(team.id);
    }

    const insertPlayer = db.prepare(
      `INSERT INTO players (guild_id, user_id, team_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id`
    );

    const rosterJobs = [];  // [teamName, discordId]
    const staffJobs  = [];  // [teamName, discordId, slot, roleName]
    const nameJobs   = [];  // [discordId, displayName]

    // Resolve the staff role NAMES once rather than per member.
    const ownerRoleName  = ownerRole  ? (interaction.guild.roles.cache.get(ownerRole)?.name  || 'Owner')   : null;
    const coach1RoleName = coach1Role ? (interaction.guild.roles.cache.get(coach1Role)?.name || 'Coach 1') : null;
    const coach2RoleName = coach2Role ? (interaction.guild.roles.cache.get(coach2Role)?.name || 'Coach 2') : null;

    let playerCount = 0;
    // Walk MEMBERS once and check which team role each holds, rather than looping every
    // member once per team (teams x members). Also means a member holding two team roles
    // is counted once, on the first team matched, instead of being inserted onto both.
    const teamByRoleId = new Map(teams.map(t => [t.role_id, t]));
    for (const member of members.values()) {
      if (member.user.bot) continue;

      // Nickname backfill applies to everyone, not just rostered players.
      const displayName = member.nickname || member.user.globalName || member.user.username || null;
      if (displayName) nameJobs.push([member.id, displayName]);

      let team = null;
      for (const [roleId, t] of teamByRoleId) {
        if (member.roles.cache.has(roleId)) { team = t; break; }
      }
      if (!team) continue;

      insertPlayer.run(interaction.guildId, member.id, team.id);
      playerCount++;
      rosterJobs.push([team.name, member.id]);

      if (ownerRole && member.roles.cache.has(ownerRole)) {
        db.prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(member.id, team.id);
        staffJobs.push([team.name, member.id, 'owner', ownerRoleName]);
      }
      if (coach1Role && member.roles.cache.has(coach1Role)) {
        db.prepare('UPDATE teams SET coach1_id = ? WHERE id = ?').run(member.id, team.id);
        staffJobs.push([team.name, member.id, 'gm', coach1RoleName]); // Coach 1 -> GM slot
      }
      if (coach2Role && member.roles.cache.has(coach2Role)) {
        db.prepare('UPDATE teams SET coach2_id = ? WHERE id = ?').run(member.id, team.id);
        staffJobs.push([team.name, member.id, 'hc', coach2RoleName]); // Coach 2 -> HC slot
      }
    }

    // One batched push instead of ~6 HTTP round-trips per player.
    let res;
    try {
      res = await bulkSyncToWebsite({ rosterJobs, staffJobs, nameJobs });
    } catch (err) {
      console.error('[sync] bulk sync threw', err);
      return interaction.editReply(
        `⚠️ Rebuilt ${playerCount} roster spot${playerCount === 1 ? '' : 's'} in the bot, but the website push failed: ${err.message || err}`
      );
    }

    // Report honestly when nothing reached the website — the old version always claimed
    // success even when every write had silently been skipped.
    if (!res.ok) {
      const why = {
        'no-active-season':      'no season is marked active on the website, so the bot has nowhere to write. Set the current season on the site first.',
        'playerdb-unavailable':  "couldn't read the website's player database.",
        'team-defs-unavailable': "couldn't read the website's team list.",
        'season-write-failed':   'the website rejected the roster write.',
        'playerdb-write-failed': 'rosters saved, but the nickname write failed.',
      }[res.reason] || `the website push failed (${res.reason || 'unknown'}).`;
      return interaction.editReply(
        `⚠️ Rebuilt ${playerCount} roster spot${playerCount === 1 ? '' : 's'} in the bot, but nothing was sent to the website — ${why}`
      );
    }

    let msg =
      `✅ Synced **${res.rostered}** roster spot${res.rostered === 1 ? '' : 's'} across ${teams.length} team${teams.length === 1 ? '' : 's'}, ` +
      `refreshed **${res.staff}** coach role${res.staff === 1 ? '' : 's'}, and updated **${res.names}** Discord nickname${res.names === 1 ? '' : 's'} on the website (season ${res.seasonId}).`;

    if (res.unregistered.length) {
      msg += `\n\n⚠️ ${res.unregistered.length} player${res.unregistered.length === 1 ? ' has' : 's have'} a team role but no website profile, so they couldn't be added to a roster: ` +
             res.unregistered.slice(0, 10).map(id => `<@${id}>`).join(', ') +
             (res.unregistered.length > 10 ? ` and ${res.unregistered.length - 10} more` : '') +
             `. They need to link their account on the website first.`;
    }
    if (res.unknownTeams.length) {
      msg += `\n\n⚠️ No website team matches ${res.unknownTeams.length === 1 ? 'this team name' : 'these team names'}: ` +
             res.unknownTeams.map(t => `\`${t}\``).join(', ') +
             `. The team name here has to match the site's team name exactly.`;
    }

    await interaction.editReply({ content: msg, allowedMentions: { parse: [] } });
  },
};