const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

const POSITIONS = { owner: 'Owner', coach_1: 'Coach 1', coach_2: 'Coach 2' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_coaches')
    .setDescription('Link a coaching position to a role')
    .addStringOption(o => o.setName('coach').setDescription('Which coaching position to set').setRequired(true)
      .addChoices({ name: 'Owner', value: 'owner' }, { name: 'Coach 1', value: 'coach_1' }, { name: 'Coach 2', value: 'coach_2' }))
    .addRoleOption(o => o.setName('role').setDescription('The role for this coaching position').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const position = interaction.options.getString('coach');
    const role = interaction.options.getRole('role');
    const label = POSITIONS[position];

    db.prepare(`INSERT INTO coach_roles (guild_id, position, role_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, position) DO UPDATE SET role_id = excluded.role_id`).run(interaction.guildId, position, role.id);

    await interaction.reply({ content: `**${label}** is now linked to ${role}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
