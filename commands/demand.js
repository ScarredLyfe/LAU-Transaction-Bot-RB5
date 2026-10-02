const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { makeFreeAgent } = require('../freeAgent');
const { getMembers, liveStaff } = require('../rosterLive');

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
    .setName('demand')
    .setDescription('Demand a release from your current team'),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const reject = (content) => interaction.editReply({ content });

    if (!settings.demands_enabled) return reject('Demands are currently disabled.');

    const team = findMemberTeam(interaction.member, teams);
    if (!team) return reject('You\'re not on a team.');

    // Athletic directors (team owners) can't demand a release from their own team.
    // Uses the live Discord roles, so someone whose Athletic Director role was removed by hand
    // can demand again, and whoever holds the role now can't.
    const ownerRole = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId);
    const liveAD = liveStaff(await getMembers(interaction.guild), interaction.guildId, team, 'owner');
    const isAthleticDirector = liveAD === interaction.user.id
      || (ownerRole && interaction.member.roles.cache.has(ownerRole.role_id));
    if (isAthleticDirector) {
      return reject('Athletic directors can\'t demand a release. Ask a league admin if you need to step down.');
    }

    const row = db.prepare('SELECT demands_used FROM players WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, interaction.user.id);
    const used = row ? row.demands_used : 0;
    if (used >= settings.max_demands) {
      return reject(`You've used all ${settings.max_demands} of your demands.`);
    }

    db.prepare(`INSERT INTO players (guild_id, user_id, team_id, demands_used) VALUES (?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET demands_used = demands_used + 1`).run(interaction.guildId, interaction.user.id, team.id);

    // makeFreeAgent also removes them from the website roster (free agent = off the site roster).
    await makeFreeAgent(interaction.guild, interaction.member, settings, team.role_id, team.name);

    await interaction.editReply({ content: `You've demanded a release from ${team.name}. Demands used: ${used + 1}/${settings.max_demands}.` });

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0xed4245;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('📤 Release Demanded 📤')
      .setDescription(`${interaction.user} \`${interaction.user.username}\` has demanded a release from ${team.emoji}\n\n> 🔁 Demands used: ${used + 1}/${settings.max_demands}`)
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    if (settings.transaction_channel_id) {
      try {
        const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
        await channel.send({ embeds: [embed], allowedMentions: { users: [interaction.user.id] } });
      } catch {}
    }
  },
};