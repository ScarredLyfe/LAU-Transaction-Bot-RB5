const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addteam')
    .setDescription('Register a new team')
    .addRoleOption(o => o.setName('role').setDescription('The team\'s Discord role').setRequired(true))
    .addStringOption(o => o.setName('emoji').setDescription('Emoji for the team').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    const emoji = interaction.options.getString('emoji') || '🏀';
    // Team name is taken from the Discord role's name. This name is what maps the team
    // to its website roster (it must match a name in the website's team_defs).
    const name = role.name;

    try {
      db.prepare('INSERT INTO teams (guild_id, name, role_id, emoji) VALUES (?, ?, ?, ?)')
        .run(interaction.guildId, name, role.id, emoji);
      await interaction.reply({ content: `Team **${name}** successfully added to database.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: 'That role is already registered as a team.', flags: MessageFlags.Ephemeral });
    }
  },
};