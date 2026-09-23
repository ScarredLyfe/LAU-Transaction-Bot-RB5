const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { bulkSyncToWebsite } = require('../firebaseSync');
const { fetchMembersCached } = require('../memberCache');

// coach_1 -> GM slot on the website, coach_2 -> HC slot on the website.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Rebuild rosters from current Discord roles and refresh the website')
    .addBooleanOption(o => o
      .setName('notify')
      .setDescription('DM rostered players who have no website account (default: true)')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Default to notifying, but allow it to be turned off so a follow-up /sync run doesn't
    // DM the same people over and over while an admin is fixing something else.
    const notify = interaction.options.getBoolean('notify');
    const shouldNotify = notify === null ? true : notify;

    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    if (teams.length === 0) return interaction.editReply('No teams are registered yet.');

    const ownerRole  = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId)?.role_id;
    const coach1Role = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_1'").get(interaction.guildId)?.role_id;
    const coach2Role = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_2'").get(interaction.guildId)?.role_id;

    // Pull every member once (needs the Server Members Intent). Goes through the shared
    // cache rather than a raw fetch -- Discord's gateway strictly rate-limits how often any
    // bot can request a guild's full member list (opcode 8), and /sync running around the
    // same time as the background watchers' own periodic fetches was enough to trip that
    // limit and make the whole command hang or fail outright. A member list that's at most
    // a minute old is a fine trade-off for an admin-run command like this.
    const members = await fetchMembersCached(interaction.guild).catch(() => interaction.guild.members.cache);

    // Wipe the old roster + coach records for this guild, then rebuild from roles.
    // demands_used must survive this: it's a running season counter that has nothing to do
    // with which team someone is on, but DELETE+INSERT would otherwise reset it to 0 for
    // everyone on every /sync -- silently undoing demand limits. Snapshot it first and
    // restore it after rebuilding.
    const savedDemands = new Map(
      db.prepare('SELECT user_id, demands_used FROM players WHERE guild_id = ?').all(interaction.guildId)
        .map(r => [r.user_id, r.demands_used])
    );
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
      const prevDemands = savedDemands.get(member.id);
      if (prevDemands) {
        db.prepare('UPDATE players SET demands_used = ? WHERE guild_id = ? AND user_id = ?')
          .run(prevDemands, interaction.guildId, member.id);
      }
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

    // Report honestly when nothing reached the website -- the old version always claimed
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

    // ── DM anyone on a roster with no linked website account ──
    const base = (process.env.WEBSITE_URL || 'https://laurb5.com').replace(/\/+$/, '');
    let dmSent = 0, dmFailed = 0;
    const dmFailedMentions = [];

    if (shouldNotify && res.unregistered.length) {
      for (const { discordId, teamName } of res.unregistered) {
        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⚠️ Registration Required')
          .setDescription(
            `You are on a roster but cannot play because you aren't registered on the website.\n\n` +
            `Team: **${teamName}**\n\n` +
            `Register here: ${base}\n\n` +
            `Sign in with Discord and link your Roblox account. Once that's done, click the ` +
            `**Verify** button in the server to get your roles, and your stats will start ` +
            `showing up on your player page.`
          );
        try {
          // members is already fetched above, so this is a cache hit -- no extra API call.
          const member = members.get(discordId) || await interaction.guild.members.fetch(discordId).catch(() => null);
          if (!member) { dmFailed++; continue; }
          await member.send({ embeds: [embed] });
          dmSent++;
        } catch (e) {
          // Almost always "Cannot send messages to this user" -- DMs closed or bot blocked.
          dmFailed++;
          dmFailedMentions.push(`<@${discordId}>`);
        }
      }
    }

    let msg =
      `✅ Synced **${res.rostered}** roster spot${res.rostered === 1 ? '' : 's'} across ${teams.length} team${teams.length === 1 ? '' : 's'}, ` +
      `refreshed **${res.staff}** coach role${res.staff === 1 ? '' : 's'}, and updated **${res.names}** Discord nickname${res.names === 1 ? '' : 's'} on the website (season ${res.seasonId}).`;

    if (res.unregistered.length) {
      msg += `\n\n⚠️ **${res.unregistered.length}** player${res.unregistered.length === 1 ? ' is' : 's are'} on a roster but not registered on the website, so they couldn't be added.`;
      if (shouldNotify) {
        msg += `\n✅ DMed: ${dmSent}`;
        if (dmFailed) {
          msg += `\n❌ Couldn't DM (DMs closed or bot blocked): ${dmFailed}`;
          if (dmFailedMentions.length) msg += `\n${dmFailedMentions.slice(0, 20).join(', ')}`;
          if (dmFailedMentions.length > 20) msg += ` and ${dmFailedMentions.length - 20} more`;
        }
      } else {
        msg += `\nDMs skipped (notify: false): ` +
               res.unregistered.slice(0, 20).map(u => `<@${u.discordId}>`).join(', ') +
               (res.unregistered.length > 20 ? ` and ${res.unregistered.length - 20} more` : '');
      }
    }

    if (res.noProfile.length) {
      // Name them — knowing the count without knowing WHO is useless for actually fixing it.
      msg += `\n\nℹ️ ${res.noProfile.length} player${res.noProfile.length === 1 ? ' has' : 's have'} a linked account but no player profile yet, so no roster spot was written for them: ` +
             res.noProfile.slice(0, 20).map(id => `<@${id}>`).join(', ') +
             (res.noProfile.length > 20 ? ` and ${res.noProfile.length - 20} more` : '') +
             `\nTheir Discord is linked, but there's no entry under their Roblox name in the site's player database — usually a half-finished link. Have them open their profile on the website and re-link Roblox.`;
    }

    if (res.unknownTeams.length) {
      msg += `\n\n⚠️ No website team matches ${res.unknownTeams.length === 1 ? 'this team name' : 'these team names'}: ` +
             res.unknownTeams.map(t => `\`${t}\``).join(', ') +
             `. The team name here has to match the site's team name exactly.`;
    }

    await interaction.editReply({ content: msg, allowedMentions: { parse: [] } });
  },
};