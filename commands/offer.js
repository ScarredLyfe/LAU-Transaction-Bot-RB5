const {
  SlashCommandBuilder, MessageFlags, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { db, ensureGuild } = require('../database');
const { addPlayerToWebsiteRoster, setWebsiteDisplayName } = require('../firebaseSync');

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
    const rosterCount = db.prepare(
      'SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?'
    ).get(interaction.guildId, team.id).c;
    if (rosterCount >= rosterSize) {
      return reject(`Your roster is full (${rosterCount}/${rosterSize}).`);
    }

    const teamRole = interaction.guild.roles.cache.get(team.role_id);
    const color = teamRole?.color || 0x5865f2;
    const teamLogo = emojiToUrl(team.emoji) || teamRole?.iconURL() || settings.bot_logo || null;
    const expiresUnix = Math.floor((Date.now() + EXPIRY_MS) / 1000);
    const coach = interaction.user;

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
      new ButtonBuilder().setCustomId('accept').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
    );

    let dm;
    try {
      dm = await player.send({ embeds: [offerEmbed], components: [buttons] });
    } catch {
      return reject('I couldn\'t DM that player — they may have DMs disabled.');
    }

    await interaction.reply({ content: `Offer sent to ${player}.`, flags: MessageFlags.Ephemeral });

    const collector = dm.createMessageComponentCollector({ time: EXPIRY_MS, max: 1 });

    collector.on('collect', async (i) => {
      try {
        await i.deferUpdate();

        const disabledRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(buttons.components[0]).setDisabled(true),
          ButtonBuilder.from(buttons.components[1]).setDisabled(true),
        );

        if (i.customId === 'accept') {
          const nowCount = db.prepare(
            'SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?'
          ).get(interaction.guildId, team.id).c;
          if (nowCount >= rosterSize) {
            await i.editReply({ content: 'This team\'s roster filled up before you accepted.', embeds: [], components: [] });
            return;
          }

          db.prepare(
            `INSERT INTO players (guild_id, user_id, team_id) VALUES (?, ?, ?)
             ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id`
          ).run(interaction.guildId, player.id, team.id);

          await playerMember.roles.add(team.role_id).catch(() => {});
          if (settings.signed_role_id) await playerMember.roles.add(settings.signed_role_id).catch(() => {});
          if (settings.free_agent_role_id) await playerMember.roles.remove(settings.free_agent_role_id).catch(() => {});

          // ── Website sync: add to the team's roster + store their Discord name ──
          addPlayerToWebsiteRoster(team.name, player.id).catch(() => {});
          setWebsiteDisplayName(player.id, playerMember).catch(() => {});

          await i.editReply({ embeds: [offerEmbed.setDescription(`✅ You accepted the offer from ${team.name}.`)], components: [disabledRow] });

          const newCount = nowCount + 1;
          const acceptEmbed = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
            .setTitle('✅ Transaction Complete ✅')
            .setDescription(
              `${player} \`${player.username}\` has accepted the offer from ${team.emoji}\n\n` +
              `> 📁 Roster: ${newCount}/${rosterSize}\n` +
              `> 💼 Coach: ${coach}`
            )
            .setTimestamp();
          if (teamLogo) acceptEmbed.setThumbnail(teamLogo);

          try {
            const channel = await interaction.guild.channels.fetch(settings.transaction_channel_id);
            await channel.send({ embeds: [acceptEmbed], allowedMentions: { users: [player.id] } });
          } catch {}
        }

        if (i.customId === 'deny') {
          await i.editReply({ embeds: [offerEmbed.setDescription('❌ You declined the offer.')], components: [disabledRow] });

          const declineEmbed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('Offer Declined')
            .setDescription(`${player} \`${playerMember.displayName}\` has declined your offer.`);
          await coach.send({ embeds: [declineEmbed] }).catch(() => {});
        }
      } catch (err) {
        console.error('Offer button error:', err);
      }
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        const expiredRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(buttons.components[0]).setDisabled(true),
          ButtonBuilder.from(buttons.components[1]).setDisabled(true),
        );
        dm.edit({ components: [expiredRow] }).catch(() => {});
      }
    });
  },
};
