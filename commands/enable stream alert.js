const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('enable_stream_alert')
    .setDescription('Get pinged for stream alerts'),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT stream_alert_role_id FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const roleId = settings && settings.stream_alert_role_id;
    if (!roleId) {
      return interaction.reply({
        content: '⚠️ No Stream Alert role has been set up yet. Ask an admin to run `/set_stream_alert`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({ content: 'Something went wrong finding your member info.', flags: MessageFlags.Ephemeral });
    }

    if (member.roles.cache.has(roleId)) {
      return interaction.reply({ content: 'You already have Stream Alert pings on.', flags: MessageFlags.Ephemeral });
    }

    try {
      await member.roles.add(roleId, 'Self opt-in via /enable_stream_alert');
      await interaction.reply({ content: '🔔 Stream Alert pings turned on.', flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('[enable_stream_alert] role add failed', err);
      await interaction.reply({
        content: '❌ Couldn\'t add the role — the bot may be missing permissions or its role is below that role.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};