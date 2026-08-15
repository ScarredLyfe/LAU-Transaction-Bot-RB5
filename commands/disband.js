const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { makeFreeAgent } = require('../freeAgent');

function emojiToUrl(emoji) {
  if (!emoji) return null;
  const match = emoji.match(/<(a?):\w+:(\d+)>/);
  if (!match) return null;
  return `https://cdn.discordapp.com/emojis/${match[2]}.${match[1] === 'a' ? 'gif' : 'png'}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('disband')
    .setDescription('Disband a team, releasing all its players to free agency')
    .addRoleOption(o => o.setName('team').setDescription('The team to disband').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const teamRoleOpt = interaction.options.getRole('team');

    const team = teams.find(t => t.role_id === teamRoleOpt.id);
    if (!team) return interaction.editReply('That role isn\'t a registered team.');

    const coachRoleIds = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ?').all(interaction.guildId).map(r => r.role_id);
    const rosterIds = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(interaction.guildId, team.id).map(r => r.user_id);

    const releasedNames = [];
    for (const userId of rosterIds) {
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (member) {
        for (const roleId of coachRoleIds) {
          if (member.roles.cache.has(roleId)) await member.roles.remove(roleId).catch(() => {});
        }
        // makeFreeAgent also removes them from the website roster (free agent = off the site roster).
        await makeFreeAgent(interaction.guild, member, settings, team.role_id, team.name);
        releasedNames.push(`<@${userId}> \`${member.user.username}\``);
      } else {
        releasedNames.push(`<@${userId}> \`(left server)\``);
        db.prepare('UPDATE players SET team_id = NULL WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, userId);
      }
    }

    db.prepare('UPDATE teams SET owner_id = NULL, coach1_id = NULL, coach2_id = NULL WHERE id = ?').run(team.id);

    let releasedList = releasedNames.map(n => `• ${n}`).join('\n') || '*No players were on the roster.*';
    if (releasedList.length > 1024) {
      releasedList = releasedList.slice(0, 1000).replace(/\n[^\n]*$/, '') + '\n*…and more*';
    }

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0xed4245;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('💥 Team Disbanded 💥')
      .setDescription(`${team.emoji} **${team.name}** has been disbanded.\n\n> 👥 Players released: ${releasedNames.length}\n> 🏆 Disbanded by: ${interaction.user}`)
      .addFields({ name: 'Released Players', value: releasedList, inline: false })
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    if (settings.transaction_channel_id) {
      try {
        const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch {}
    }

    await interaction.editReply(`✅ Disbanded **${team.name}** and released ${releasedNames.length} player${releasedNames.length === 1 ? '' : 's'}.`);
  },
};
