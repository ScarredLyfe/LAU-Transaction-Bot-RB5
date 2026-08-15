const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_bot_name')
    .setDescription('Set the league name shown in embeds')
    .addStringOption(o => o.setName('name').setDescription('League name').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const name = interaction.options.getString('name');
    db.prepare('UPDATE guild_settings SET bot_name = ? WHERE guild_id = ?').run(name, interaction.guildId);
    await interaction.reply({ content: `League name set to **${name}**.`, flags: MessageFlags.Ephemeral });
  },
};
