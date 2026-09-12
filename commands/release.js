const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
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

    const callerIsOwner   = coachTeam.owner_id === interaction.user.id;
    const callerIsCoach   = coachTeam.coach1_id === interaction.user.id || coachTeam.coach2_id === interaction.user.id;
    const callerIsManager = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    if (!callerIsOwner && !callerIsCoach && !callerIsManager) {
      return reject('Only your team\'s Owner or a coach can release players.');
    }

    let playerMember;
    try { playerMember = await interaction.guild.members.fetch(player.id); }
    catch { return reject('That user isn\'t in this server.'); }

    const playerTeam = findMemberTeam(playerMember, teams);
    if (!playerTeam || playerTeam.id !== coachTeam.id) return reject('That player isn\'t on your team.');

    const targetIsOwner = playerTeam.owner_id === player.id;
    const targetIsCoach = playerTeam.coach1_id === player.id || playerTeam.coach2_id === player.id;

    if (player.id === interaction.user.id) {
      return reject('You can\'t release yourself. Use /demand if you want to leave your team.');
    }
    if (targetIsOwner) {
      return reject('The Owner can\'t be released. The only way an Athletic Director loses their spot is by disbanding the team.');
    }
    if (targetIsCoach && callerIsCoach && !callerIsOwner && !callerIsManager) {
      return reject('Coaches can\'t release other coaches. Only the Owner can release a coach.');
    }

    const teamRole = interaction.guild.roles.cache.get(coachTeam.role_id);
    const color = teamRole?.color || 0xed4245;
    const teamLogo = emojiToUrl(coachTeam.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const coach = interaction.user;

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