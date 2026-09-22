const {
  SlashCommandBuilder, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { db, ensureGuild } = require('../database');
const { fetchMembersCached } = require('../memberCache');

const EXPIRY_MS = 24 * 60 * 60 * 1000;

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
    .setName('offer')
    .setDescription('Offer a player a spot on your team')
    .addUserOption(o => o.setName('player').setDescription('The player to offer').setRequired(true)),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const player = interaction.options.getUser('player');

    const reject = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (!settings.signings_enabled) return reject('Offers are currently disabled.');
    if (!settings.transaction_channel_id) return reject('No transaction channel is set. Use /set_transaction_channel first.');
    if (player.bot) return reject('You can\'t offer a bot.');
    if (player.id === interaction.user.id) return reject('You can\'t offer yourself.');

    const team = findMemberTeam(interaction.member, teams);
    if (!team) return reject('You must be on a team to offer players.');

    let playerMember;
    try {
      playerMember = await interaction.guild.members.fetch(player.id);
    } catch {
      return reject('That user isn\'t in this server.');
    }

    if (findMemberTeam(playerMember, teams)) {
      return reject('That player is already on a team.');
    }

    const rosterSize = settings.roster_size;
    // Count only players who are BOTH still in the database as this team's roster AND
    // currently hold the team's Discord role -- not just the database alone. If someone's
    // team role was ever removed outside of /release (an admin stripping it by hand, a role
    // mixup, etc.), the database row can keep counting them long after they're actually gone,
    // silently blocking every future offer even though the roster looks well under cap in
    // Discord. This is the same live-role check /roster already uses, for the same reason.
    const rosterRows = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(interaction.guildId, team.id);
    const members = await fetchMembersCached(interaction.guild).catch(() => interaction.guild.members.cache);
    const rosterCount = rosterRows.filter(r => {
      const m = members.get(r.user_id);
      return m && m.roles.cache.has(team.role_id);
    }).length;
    if (rosterCount >= rosterSize) {
      return reject(`Your roster is full (${rosterCount}/${rosterSize}).`);
    }

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const createdAt = Date.now();
    const expiresAt = createdAt + EXPIRY_MS;
    const expiresUnix = Math.floor(expiresAt / 1000);
    const coach = interaction.user;

    // Persist the offer FIRST so its id can be baked into the button customId. Buttons are
    // handled by the GLOBAL InteractionCreate listener + offerHandler, looking the offer up
    // from this row -- so Accept/Deny keeps working even if the bot restarts before the player
    // clicks. (The old version used an in-memory collector that died on every restart, which
    // is why offers "sometimes worked, sometimes didn't.")
    const info = db.prepare(
      `INSERT INTO pending_offers
       (guild_id, team_id, coach_id, player_id, roster_size, team_name, team_emoji, team_color, team_logo, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      interaction.guildId, team.id, coach.id, player.id, rosterSize,
      team.name, team.emoji || '', color, teamLogo, createdAt, expiresAt
    );
    const offerId = info.lastInsertRowid;

    const offerEmbed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: settings.bot_name || interaction.client.user.username })
      .setTitle(`${team.emoji} ${team.name}`)
      .setDescription(`${player} \`${player.username}\` has received an offer from ${team.emoji} ${team.name}`)
      .addFields(
        { name: '📁 Roster', value: `${rosterCount}/${rosterSize}`, inline: false },
        { name: '💼 Coach', value: `${coach} \`${coach.username}\``, inline: false },
        { name: '⏰ Offer expires', value: `<t:${expiresUnix}:R>`, inline: false },
      );
    if (teamLogo) offerEmbed.setThumbnail(teamLogo);

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`offer_accept_${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`offer_deny_${offerId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );

    let dm;
    try {
      dm = await player.send({ embeds: [offerEmbed], components: [buttons] });
    } catch {
      db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
      return reject('I couldn\'t DM that player -- they may have DMs disabled.');
    }

    db.prepare('UPDATE pending_offers SET dm_channel_id = ?, message_id = ? WHERE id = ?')
      .run(dm.channelId, dm.id, offerId);

    await interaction.reply({ content: `Offer sent to ${player}.`, flags: MessageFlags.Ephemeral });
  },
};