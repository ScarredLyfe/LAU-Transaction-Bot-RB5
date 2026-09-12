const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('disable_event_ping')
    .setDescription('Stop getting pinged for events'),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT event_ping_role_id FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const roleId = settings && settings.event_ping_role_id;
    if (!roleId) {
      return interaction.reply({
        content: '⚠️ No Event Ping role has been set up yet. Ask an admin to run `/set_event_ping`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({ content: 'Something went wrong finding your member info.', flags: MessageFlags.Ephemeral });
    }

    if (!member.roles.cache.has(roleId)) {
      return interaction.reply({ content: 'You already don\'t have Event Ping on.', flags: MessageFlags.Ephemeral });
    }

    try {
      await member.roles.remove(roleId, 'Self opt-out via /disable_event_ping');
      await interaction.reply({ content: '🔕 Event Ping turned off.', flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('[disable_event_ping] role remove failed', err);
      await interaction.reply({
        content: '❌ Couldn\'t remove the role — the bot may be missing permissions or its role is below that role.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};