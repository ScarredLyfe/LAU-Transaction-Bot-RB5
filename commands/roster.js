const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

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

    const ownerRoleId  = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId)?.role_id;
    const coach1RoleId = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_1'").get(interaction.guildId)?.role_id;
    const coach2RoleId = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_2'").get(interaction.guildId)?.role_id;

    const ownerRoleName  = (ownerRoleId  && interaction.guild.roles.cache.get(ownerRoleId)?.name)  || 'Owner';
    const coach1RoleName = (coach1RoleId && interaction.guild.roles.cache.get(coach1RoleId)?.name) || 'Coach 1';
    const coach2RoleName = (coach2RoleId && interaction.guild.roles.cache.get(coach2RoleId)?.name) || 'Coach 2';

    const rows = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(interaction.guildId, team.id);
    const coachIds = [team.owner_id, team.coach1_id, team.coach2_id].filter(Boolean);

    const ownerLine  = team.owner_id  ? await formatUser(interaction.client, team.owner_id)  : '*None*';
    const coach1Line = team.coach1_id ? await formatUser(interaction.client, team.coach1_id) : '*None*';
    const coach2Line = team.coach2_id ? await formatUser(interaction.client, team.coach2_id) : '*None*';

    const playerIds = rows.map(r => r.user_id).filter(id => !coachIds.includes(id));
    const playerLines = [];
    for (const id of playerIds) playerLines.push('• ' + await formatUser(interaction.client, id));
    let playersText = playerLines.join('\n') || '*None*';
    if (playersText.length > 1024) playersText = playersText.slice(0, 1000).replace(/\n[^\n]*$/, '') + '\n*…and more*';

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const leagueName = settings.bot_name || interaction.guild.name;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: leagueName, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle(`${team.emoji} ${team.name} Roster`)
      .addFields(
        { name: '📋 Roster Count', value: `${rows.length}/${settings.roster_size}`, inline: false },
        { name: `👑 ${ownerRoleName}`,  value: ownerLine,  inline: false },
        { name: `🅰️ ${coach1RoleName}`, value: coach1Line, inline: false },
        { name: `🅱️ ${coach2RoleName}`, value: coach2Line, inline: false },
        { name: '🏀 Players', value: playersText, inline: false },
      )
      .setFooter({ text: `Roster for ${leagueName}` })
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
