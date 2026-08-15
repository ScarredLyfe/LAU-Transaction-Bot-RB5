const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_max_demands')
    .setDescription('Set how many demands a player can use')
    .addIntegerOption(o => o.setName('amount').setDescription('Max demands').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const amount = interaction.options.getInteger('amount');
    db.prepare('UPDATE guild_settings SET max_demands = ? WHERE guild_id = ?').run(amount, interaction.guildId);
    await interaction.reply({ content: `Max demands set to ${amount}.`, flags: MessageFlags.Ephemeral });
  },
};
