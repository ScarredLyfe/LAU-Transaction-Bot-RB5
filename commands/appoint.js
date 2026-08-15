const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');
const { addPlayerToWebsiteRoster, setWebsiteStaffRole, setWebsiteDisplayName } = require('../firebaseSync');

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
    .setName('appoint')
    .setDescription('Appoint a user as the owner of a team')
    .addUserOption(o => o.setName('user').setDescription('The user to appoint').setRequired(true))
    .addRoleOption(o => o.setName('team').setDescription('The team to appoint them to').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const user = interaction.options.getUser('user');
    const teamRoleOpt = interaction.options.getRole('team');

    const reject = (content) => interaction.editReply({ content });

    const team = teams.find(t => t.role_id === teamRoleOpt.id);
    if (!team) return reject('That role isn\'t a registered team. Use /addteam first.');
    if (user.bot) return reject('You can\'t appoint a bot.');

    let member;
    try { member = await interaction.guild.members.fetch(user.id); }
    catch { return reject('That user isn\'t in this server.'); }

    const ownerRole = db.prepare("SELECT role_id FROM coach_roles WHERE guild_id = ? AND position = 'owner'").get(interaction.guildId);
    if (!ownerRole) return reject('No Owner role is set. Use /set_coaches to set the Owner role first.');

    if (member.roles.cache.has(ownerRole.role_id) && member.roles.cache.has(team.role_id)) {
      return reject(`${user} is already the owner of ${team.name}.`);
    }
    if (team.owner_id && team.owner_id !== user.id) {
      const currentOwner = await interaction.guild.members.fetch(team.owner_id).catch(() => null);
      if (currentOwner && currentOwner.roles.cache.has(ownerRole.role_id) && currentOwner.roles.cache.has(team.role_id)) {
        return reject(`${currentOwner} already holds the owner and team roles for ${team.name}. Release or disband them first.`);
      }
    }
    const currentTeam = findMemberTeam(member, teams);
    if (currentTeam && currentTeam.id !== team.id) {
      return reject('That user is already on another team. Release them first.');
    }

    await member.roles.add(team.role_id).catch(() => {});
    await member.roles.add(ownerRole.role_id).catch(() => {});
    if (settings.signed_role_id) await member.roles.add(settings.signed_role_id).catch(() => {});
    if (settings.free_agent_role_id) await member.roles.remove(settings.free_agent_role_id).catch(() => {});

    db.prepare(`INSERT INTO players (guild_id, user_id, team_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id`).run(interaction.guildId, user.id, team.id);
    db.prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(user.id, team.id);

    // ── Website sync: add to roster, set them as owner, and store their Discord name ──
    const ownerRoleObj = interaction.guild.roles.cache.get(ownerRole.role_id);
    const ownerRoleName = ownerRoleObj ? ownerRoleObj.name : 'Owner';
    await addPlayerToWebsiteRoster(team.name, user.id).catch(() => {});
    await setWebsiteStaffRole(team.name, user.id, 'owner', ownerRoleName).catch(() => {});
    await setWebsiteDisplayName(user.id, member).catch(() => {});

    await interaction.editReply({ content: `${user} has been appointed owner of ${team.name}.` });

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const rosterCount = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(interaction.guildId, team.id).c;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
      .setTitle('📋 Owner Appointed 📋')
      .setDescription(`${user} \`${user.username}\` has been appointed owner of ${team.emoji}\n\n> 📁 Roster: ${rosterCount}/${settings.roster_size}\n> 💼 Appointed by: ${interaction.user}`)
      .setTimestamp();
    if (teamLogo) embed.setThumbnail(teamLogo);

    try {
      const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
      if (channel) await channel.send({ embeds: [embed], allowedMentions: { users: [user.id] } });
    } catch {}
  },
};
