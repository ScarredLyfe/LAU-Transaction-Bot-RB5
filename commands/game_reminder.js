const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { fetchMembersCached } = require('../memberCache');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('game_reminder')
    .setDescription('DM everyone on both teams a reminder about their upcoming game')
    .addRoleOption(o => o.setName('team1').setDescription('First team role').setRequired(true))
    .addRoleOption(o => o.setName('team2').setDescription('Second team role').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Game time (e.g. 8:00 PM EST)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const team1 = interaction.options.getRole('team1');
    const team2 = interaction.options.getRole('team2');
    const time = interaction.options.getString('time');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const members = await fetchMembersCached(interaction.guild).catch(() => interaction.guild.members.cache);

    // Collect everyone on EITHER team, deduped, along with which team (and opponent) they're
    // actually on -- someone on Team1 gets told they're playing Team2, and vice versa.
    const targets = [];
    const seen = new Set();
    members.forEach(member => {
      if (member.user.bot) return;
      const onTeam1 = member.roles.cache.has(team1.id);
      const onTeam2 = member.roles.cache.has(team2.id);
      if (!onTeam1 && !onTeam2) return;
      if (seen.has(member.id)) return;
      seen.add(member.id);
      targets.push({ member, ownTeam: onTeam1 ? team1 : team2, opponent: onTeam1 ? team2 : team1 });
    });

    if (!targets.length) {
      return interaction.editReply(`Nobody on ${team1} or ${team2} was found to remind.`);
    }

    let sent = 0, failed = 0;
    const failedMentions = [];

    for (const { member, ownTeam, opponent } of targets) {
      const embed = new EmbedBuilder()
        .setColor(0x4f8ef7)
        .setTitle('⏰ Game Reminder')
        .setDescription(
          `You have a game today at **${time}**.\n\n` +
          `**${ownTeam.name}** vs **${opponent.name}**`
        );
      try {
        await member.send({ embeds: [embed] }); // exactly one DM per person
        sent++;
      } catch (e) {
        failed++;
        failedMentions.push(`<@${member.id}>`);
      }
    }

    let summary = `Reminded ${targets.length} player${targets.length === 1 ? '' : 's'} about ${team1} vs ${team2} at ${time}.\n` +
      `✅ DMed: ${sent}`;
    if (failed) {
      summary += `\n❌ Couldn't DM (blocked bot / left server): ${failed}`;
      if (failedMentions.length) summary += `\n${failedMentions.slice(0, 20).join(', ')}`;
    }

    await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
  },
};