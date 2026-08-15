const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addteam')
    .setDescription('Register a new team')
    .addStringOption(o => o.setName('name').setDescription('Team name').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('The team\'s Discord role').setRequired(true))
    .addStringOption(o => o.setName('emoji').setDescription('Emoji for the team').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const emoji = interaction.options.getString('emoji') || '🏀';

    try {
      db.prepare('INSERT INTO teams (guild_id, name, role_id, emoji) VALUES (?, ?, ?, ?)')
        .run(interaction.guildId, name, role.id, emoji);
      await interaction.reply({ content: 'Team successfully added to database', flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: 'That role is already registered as a team.', flags: MessageFlags.Ephemeral });
    }
  },
};
