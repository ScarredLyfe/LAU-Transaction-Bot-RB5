const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { makeFreeAgent } = require('../freeAgent');

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
    .setName('release')
    .setDescription('Release a player from your team')
    .addUserOption(o => o.setName('player').setDescription('The player to release').setRequired(true)),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const player = interaction.options.getUser('player');
    const reject = (content) => interaction.editReply({ content });

    if (!settings.releases_enabled) return reject('Releases are currently disabled.');
    if (!settings.transaction_channel_id) return reject('No transaction channel is set. Use /set_transaction_channel first.');

    const coachTeam = findMemberTeam(interaction.member, teams);
    if (!coachTeam) return reject('You must be on a team to release players.');

    let playerMember;
    try { playerMember = await interaction.guild.members.fetch(player.id); }
    catch { return reject('That user isn\'t in this server.'); }

    const playerTeam = findMemberTeam(playerMember, teams);
    if (!playerTeam || playerTeam.id !== coachTeam.id) return reject('That player isn\'t on your team.');

    const teamRole = interaction.guild.roles.cache.get(coachTeam.role_id);
    const color = teamRole?.color || 0xed4245;
    const teamLogo = emojiToUrl(coachTeam.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const coach = interaction.user;

    // makeFreeAgent also removes them from the website roster (free agent = off the site roster).
    await makeFreeAgent(interaction.guild, playerMember, settings, coachTeam.role_id, coachTeam.name);

    await interaction.editReply({ content: `${player} has been released.` });

    const rosterCount = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(interaction.guildId, coachTeam.id).c;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('Release')
      .setDescription(`${coachTeam.emoji} <@&${coachTeam.role_id}> has released ${player}\n\n> 📁 Roster: ${rosterCount}/${settings.roster_size}\n> 🏆 Released by: ${coach}`)
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    try {
      const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
      await channel.send({ embeds: [embed], allowedMentions: { users: [player.id] } });
    } catch {}
  },
};
