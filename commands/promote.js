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
    .setName('promote')
    .setDescription('Promote a player on your roster to a coaching position')
    .addUserOption(o => o.setName('user').setDescription('The player to promote').setRequired(true))
    .addStringOption(o => o.setName('coach').setDescription('Which coaching position').setRequired(true).setAutocomplete(true)),

  async autocomplete(interaction) {
    const c1 = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_1'").get(interaction.guildId)?.role_id;
    const c2 = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'coach_2'").get(interaction.guildId)?.role_id;
    const n1 = (c1 && interaction.guild.roles.cache.get(c1)?.name) || 'Coach 1';
    const n2 = (c2 && interaction.guild.roles.cache.get(c2)?.name) || 'Coach 2';
    const choices = [{ name: n1, value: 'coach_1' }, { name: n2, value: 'coach_2' }];
    const typed = (interaction.options.getFocused() || '').toLowerCase();
    await interaction.respond(choices.filter(c => c.name.toLowerCase().includes(typed)));
  },

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const user = interaction.options.getUser('user');
    const positionKey = interaction.options.getString('coach');
    const reject = (content) => interaction.editReply({ content });

    const pos = POSITIONS[positionKey];
    if (!pos) return reject('Pick a valid coaching position from the list.');
    const { column, slot } = pos;

    const ownerRole = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId);
    if (!ownerRole) return reject('No Owner role is set. An admin must run /set_coaches first.');

    const team = findMemberTeam(interaction.member, teams);
    if (!team || !interaction.member.roles.cache.has(ownerRole.role_id)) return reject('Only a team owner can use this command.');

    const coachRole = db.prepare('SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = ?').get(interaction.guildId, positionKey);
    if (!coachRole) return reject('That coaching role isn\'t set. An admin must run /set_coaches first.');

    const label = interaction.guild.roles.cache.get(coachRole.role_id)?.name || 'Coach';
    if (user.bot) return reject('You can\'t promote a bot.');
    if (user.id === interaction.user.id) return reject('You can\'t promote yourself.');

    let member;
    try { member = await interaction.guild.members.fetch(user.id); }
    catch { return reject('That user isn\'t in this server.'); }

    const onRoster = db.prepare('SELECT 1 FROM players WHERE guild_id = ? AND user_id = ? AND team_id = ?').get(interaction.guildId, user.id, team.id);
    if (!onRoster || !member.roles.cache.has(team.role_id)) return reject('That player isn\'t on your roster.');

    const heldBy = team[column];
    if (heldBy) {
      if (heldBy === user.id) return reject(`${user} is already ${label} of ${team.name}.`);
      const holder = await interaction.guild.members.fetch(heldBy).catch(() => null);
      if (holder && holder.roles.cache.has(coachRole.role_id) && holder.roles.cache.has(team.role_id)) {
        return reject(`${holder} is already ${label} of ${team.name}. Demote them first.`);
      }
    }

    await member.roles.add(coachRole.role_id).catch(() => {});
    db.prepare(`UPDATE teams SET ${column} = ? WHERE id = ?`).run(user.id, team.id);

    // ── Website sync: set them in the matching staff slot (gm/hc) ──
    await setWebsiteStaffRole(team.name, user.id, slot, label).catch(() => {});

    await interaction.editReply({ content: `${user} has been promoted to <@&${coachRole.role_id}> of ${team.name}.` });

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('Promotion')
      .setDescription(`${team.emoji} <@&${team.role_id}> has promoted ${user} to <@&${coachRole.role_id}>\n\n> 🏆 Promoted by: ${interaction.user}`)
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    try {
      const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
      if (channel) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch {}
  },
};
