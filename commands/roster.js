const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { getMembers, liveRosterIds, liveStaff } = require('../rosterLive');

function emojiToUrl(emoji) {
  if (!emoji) return null;
  const match = emoji.match(/<(a?):\w+:(\d+)>/);
  if (!match) return null;
  return `https://cdn.discordapp.com/emojis/${match[2]}.${match[1] === 'a' ? 'gif' : 'png'}`;
}

async function formatUser(client, id) {
  const user = await client.users.fetch(id).catch(() => null);
  return user ? `<@${id}> \`${user.username}\`` : `<@${id}>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roster')
    .setDescription('View a team roster')
    .addRoleOption(o => o.setName('team').setDescription('The team to view').setRequired(true)),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const teamRoleOpt = interaction.options.getRole('team');

    const reject = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    const team = teams.find(t => t.role_id === teamRoleOpt.id);
    if (!team) return reject('That role isn\'t a registered team.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await getMembers(interaction.guild);

    const ownerRoleId  = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId)?.role_id;
    const coach1RoleId = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_1'").get(interaction.guildId)?.role_id;
    const coach2RoleId = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_2'").get(interaction.guildId)?.role_id;

    const ownerRoleName  = (ownerRoleId  && interaction.guild.roles.cache.get(ownerRoleId)?.name)  || 'Owner';
    const coach1RoleName = (coach1RoleId && interaction.guild.roles.cache.get(coach1RoleId)?.name) || 'Coach 1';
    const coach2RoleName = (coach2RoleId && interaction.guild.roles.cache.get(coach2RoleId)?.name) || 'Coach 2';

    // Only people who currently hold the team role count. Staff spots are read from the live
    // Discord roles too, so removing someone's Athletic Director / coach role by hand shows
    // up right away instead of the old holder staying listed.
    const rosterIds = liveRosterIds(members, interaction.guildId, team);
    const ownerId  = liveStaff(members, interaction.guildId, team, 'owner');
    const coach1Id = liveStaff(members, interaction.guildId, team, 'coach_1');
    const coach2Id = liveStaff(members, interaction.guildId, team, 'coach_2');
    const coachIds = [ownerId, coach1Id, coach2Id].filter(Boolean);

    const ownerLine  = ownerId  ? await formatUser(interaction.client, ownerId)  : '*None*';
    const coach1Line = coach1Id ? await formatUser(interaction.client, coach1Id) : '*None*';
    const coach2Line = coach2Id ? await formatUser(interaction.client, coach2Id) : '*None*';

    const playerIds = rosterIds.filter(id => !coachIds.includes(id));
    const playerLines = [];
    for (const id of playerIds) {
      playerLines.push('• ' + await formatUser(interaction.client, id));
    }
    let playersText = playerLines.join('\n') || '*None*';
    if (playersText.length > 1024) {
      playersText = playersText.slice(0, 1000).replace(/\n[^\n]*$/, '') + '\n*…and more*';
    }

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const leagueName = settings.bot_name || interaction.guild.name;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: leagueName, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle(`${team.emoji} ${team.name} Roster`)
      .addFields(
        { name: '📋 Roster Count', value: `${rosterIds.length}/${settings.roster_size}`, inline: true },
        { name: `👑 ${ownerRoleName}`,  value: ownerLine,  inline: false },
        { name: `🅰️ ${coach1RoleName}`, value: coach1Line, inline: false },
        { name: `🅱️ ${coach2RoleName}`, value: coach2Line, inline: false },
        { name: '🏀 Players', value: playersText, inline: false },
      )
      .setFooter({ text: `Roster for ${leagueName} • verified against live Discord roles` })
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};