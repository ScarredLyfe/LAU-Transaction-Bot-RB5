const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { getMembers, liveRosterIds } = require('../rosterLive');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('viewteams')
    .setDescription('View all teams in the database')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const teams = db.prepare(
      'SELECT id, name, emoji, role_id FROM teams WHERE guild_id = ? ORDER BY name COLLATE NOCASE'
    ).all(interaction.guildId);

    if (teams.length === 0) {
      return interaction.reply({
        content: 'There are no teams in the database.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Roster count per team: players on that team who still hold its Discord role.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await getMembers(interaction.guild);

    const list = teams.map(t => {
      const count = liveRosterIds(members, interaction.guildId, t).length;
      return `${t.emoji} <@&${t.role_id}> \`(${count} on roster)\``;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Teams')
      .setDescription(list)
      .setFooter({ text: `${teams.length} team${teams.length === 1 ? '' : 's'} total` });

    await interaction.editReply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  },
};