const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_roster_size')
    .setDescription('Set the max roster size per team')
    .addIntegerOption(o => o.setName('size').setDescription('Max players per team').setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const size = interaction.options.getInteger('size');
    db.prepare('UPDATE guild_settings SET roster_size = ? WHERE guild_id = ?').run(size, interaction.guildId);
    await interaction.reply({ content: `Max roster size set to ${size}.`, flags: MessageFlags.Ephemeral });
  },
};
