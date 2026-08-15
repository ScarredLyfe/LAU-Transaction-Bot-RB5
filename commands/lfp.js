const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

function findMemberTeam(member, teams) {
  return teams.find(t => member.roles.cache.has(t.role_id));
}
function emojiToUrl(emoji) {
  if (!emoji) return null;
  const match = emoji.match(/<(a?):\w+:(\d+)>/);
  if (!match) return null;
  return `https://cdn.discordapp.com/emojis/${match[2]}.${match[1] === 'a' ? 'gif' : 'png'}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lfp')
    .setDescription('Post a Looking For Players ad for your team')
    .addStringOption(o => o.setName('message').setDescription('Info about the opening').setRequired(true)),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const message = interaction.options.getString('message');
    const reject = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (!settings.lfp_channel_id) return reject('No LFP channel is set. Use /set_lfp first.');

    const team = findMemberTeam(interaction.member, teams);
    if (!team) return reject('You must be on a team to post an LFP.');

    const rosterCount = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(interaction.guildId, team.id).c;

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle(`${team.emoji} ${team.name} is Looking For Players`)
      .setDescription(message)
      .addFields(
        { name: '📁 Roster', value: `${rosterCount}/${settings.roster_size}`, inline: true },
        { name: '💼 Posted by', value: `${interaction.user}`, inline: true },
      )
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    try {
      const channel = await interaction.guild.channels.fetch(settings.lfp_channel_id);
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: 'LFP posted!', flags: MessageFlags.Ephemeral });
    } catch {
      await reject('I couldn\'t post to the LFP channel — check my permissions there.');
    }
  },
};
