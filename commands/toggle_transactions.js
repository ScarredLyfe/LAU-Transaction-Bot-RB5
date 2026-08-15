const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

const COLUMNS = { signings: 'signings_enabled', releases: 'releases_enabled', demands: 'demands_enabled' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('toggle_transactions')
    .setDescription('Turn a transaction type on or off')
    .addStringOption(o => o.setName('action').setDescription('Which transaction type').setRequired(true)
      .addChoices({ name: 'Signings (offers)', value: 'signings' }, { name: 'Releases', value: 'releases' }, { name: 'Demands', value: 'demands' }))
    .addStringOption(o => o.setName('status').setDescription('On or off').setRequired(true)
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const action = interaction.options.getString('action');
    const status = interaction.options.getString('status');
    const column = COLUMNS[action];
    const value = status === 'on' ? 1 : 0;

    db.prepare(`UPDATE guild_settings SET ${column} = ? WHERE guild_id = ?`).run(value, interaction.guildId);
    await interaction.reply({ content: `${action[0].toUpperCase() + action.slice(1)} are now **${status === 'on' ? 'enabled' : 'disabled'}**.`, flags: MessageFlags.Ephemeral });
  },
};
