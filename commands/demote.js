const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { setWebsiteStaffRole } = require('../firebaseSync');

function findMemberTeam(member, teams) {
  return teams.find(t => member.roles.cache.has(t.role_id));
}
function emojiToUrl(emoji) {
  if (!emoji) return null;
  const match = emoji.match(/<(a?):\w+:(\d+)>/);
  if (!match) return null;
  return `https://cdn.discordapp.com/emojis/${match[2]}.${match[1] === 'a' ? 'gif' : 'png'}`;
}

// coach_1 -> GM slot on the website, coach_2 -> HC slot on the website.
const POSITIONS = { coach_1: { column: 'coach1_id', slot: 'gm' }, coach_2: { column: 'coach2_id', slot: 'hc' } };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('demote')
    .setDescription('Remove a coach role from a player on your roster')
    .addUserOption(o => o.setName('user').setDescription('The coach to demote').setRequired(true)),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const user = interaction.options.getUser('user');
    const reject = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    const ownerRole = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId);
    if (!ownerRole) return reject('No Owner role is set. An admin must run /set_coaches first.');

    const team = findMemberTeam(interaction.member, teams);
    if (!team || !interaction.member.roles.cache.has(ownerRole.role_id)) return reject('Only a team owner can use this command.');
    if (user.id === interaction.user.id) return reject('You can\'t demote yourself.');

    let member;
    try { member = await interaction.guild.members.fetch(user.id); }
    catch { return reject('That user isn\'t in this server.'); }

    if (!member.roles.cache.has(team.role_id)) return reject('That player isn\'t on your roster.');

    let found = null;
    for (const positionKey of ['coach_1', 'coach_2']) {
      const cr = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = ?').get(interaction.guildId, positionKey);
      if (!cr) continue;
      const { column, slot } = POSITIONS[positionKey];
      const holdsRole = member.roles.cache.has(cr.role_id);
      const recordedHere = team[column] === user.id;
      if (holdsRole || recordedHere) { found = { roleId: cr.role_id, column, slot }; break; }
    }
    if (!found) return reject(`${user} isn't a coach on ${team.name}.`);

    await member.roles.remove(found.roleId).catch(() => {});
    if (team[found.column] === user.id) {
      db.prepare(`UPDATE teams SET ${found.column} = NULL WHERE id = ?`).run(team.id);
    }

    // ── Website sync: clear their staff slot (gm/hc) — they stay on the roster ──
    setWebsiteStaffRole(team.name, user.id, found.slot, null).catch(() => {});

    await interaction.reply({ content: `${user} has been demoted from <@&${found.roleId}> of ${team.name}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('Demotion')
      .setDescription(`${team.emoji} <@&${team.role_id}> has demoted ${user} from <@&${found.roleId}>\n\n> 🏆 Demoted by: ${interaction.user}`)
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    try {
      const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
      if (channel) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch {}
  },
};
