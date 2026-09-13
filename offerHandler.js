// Handles clicks on an offer's Accept/Deny buttons from index.js's GLOBAL InteractionCreate
// listener — NOT a per-message collector tied to one process run. Each button encodes the
// offer's row id (offer_accept_<id> / offer_deny_<id>) and everything is looked up fresh from
// pending_offers, so a click works even if the bot restarted since the offer was sent.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { db } = require('./database');
const { addPlayerToWebsiteRoster, setWebsiteDisplayName } = require('./firebaseSync');

function disabledRowFrom(message) {
  const row = message.components[0];
  if (!row) return new ActionRowBuilder();
  return new ActionRowBuilder().addComponents(
    row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
  );
}

async function handleOfferButton(interaction) {
  const [, action, idStr] = interaction.customId.split('_');
  const offerId = parseInt(idStr, 10);

  // Acknowledge FIRST (within Discord's 3s window) so it never shows "Interaction failed".
  await interaction.deferUpdate();

  const offer = db.prepare('SELECT * FROM pending_offers WHERE id = ?').get(offerId);

  if (!offer || offer.status !== 'pending') {
    try {
      await interaction.editReply({
        components: interaction.message.components.length ? [disabledRowFrom(interaction.message)] : [],
      });
    } catch {}
    return;
  }

  if (Date.now() > offer.expires_at) {
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
    try { await interaction.editReply({ components: [disabledRowFrom(interaction.message)] }); } catch {}
    return;
  }

  // Atomically claim so a double-click can't double-process.
  const claim = db.prepare("UPDATE pending_offers SET status = 'processing' WHERE id = ? AND status = 'pending'").run(offerId);
  if (claim.changes === 0) {
    try { await interaction.editReply({ components: [disabledRowFrom(interaction.message)] }); } catch {}
    return;
  }

  const guild = interaction.client.guilds.cache.get(offer.guild_id)
    || await interaction.client.guilds.fetch(offer.guild_id).catch(() => null);
  if (!guild) return;

  const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(offer.guild_id);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(offer.team_id);

  const baseEmbed = interaction.message.embeds[0]
    ? EmbedBuilder.from(interaction.message.embeds[0])
    : new EmbedBuilder();

  if (action === 'deny') {
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('denied', offerId);
    await interaction.editReply({
      embeds: [baseEmbed.setDescription('❌ You declined the offer.')],
      components: [disabledRowFrom(interaction.message)],
    });
    try {
      const coach = await interaction.client.users.fetch(offer.coach_id);
      const player = await interaction.client.users.fetch(offer.player_id);
      const playerMember = await guild.members.fetch(offer.player_id).catch(() => null);
      const declineEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Offer Declined')
        .setDescription(`${player} \`${(playerMember && playerMember.displayName) || player.username}\` has declined your offer.`);
      await coach.send({ embeds: [declineEmbed] }).catch(() => {});
    } catch {}
    return;
  }

  // ── Accept ──
  if (!team) {
    await interaction.editReply({ content: 'That team no longer exists.', embeds: [], components: [] });
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
    return;
  }

  const nowCount = db.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?'
  ).get(offer.guild_id, offer.team_id).c;
  if (nowCount >= offer.roster_size) {
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
    await interaction.editReply({ content: 'This team\'s roster filled up before you accepted.', embeds: [], components: [] });
    return;
  }

  const playerMember = await guild.members.fetch(offer.player_id).catch(() => null);
  if (!playerMember) {
    await interaction.editReply({ content: 'Couldn\'t find you in that server anymore.', embeds: [], components: [] });
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
    return;
  }

  const alreadyOnTeam = db.prepare('SELECT team_id FROM players WHERE guild_id = ? AND user_id = ?').get(offer.guild_id, offer.player_id);
  if (alreadyOnTeam && alreadyOnTeam.team_id && alreadyOnTeam.team_id !== offer.team_id) {
    db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offerId);
    await interaction.editReply({ content: 'You\'re already on another team, so this offer can\'t be accepted.', embeds: [], components: [] });
    return;
  }

  db.prepare(
    `INSERT INTO players (guild_id, user_id, team_id) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id`
  ).run(offer.guild_id, offer.player_id, offer.team_id);
  db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('accepted', offerId);

  addPlayerToWebsiteRoster(team.name, offer.player_id).catch(() => {});
  setWebsiteDisplayName(offer.player_id, playerMember).catch(() => {});

  await playerMember.roles.add(team.role_id).catch(() => {});
  if (settings && settings.signed_role_id) await playerMember.roles.add(settings.signed_role_id).catch(() => {});
  if (settings && settings.free_agent_role_id) await playerMember.roles.remove(settings.free_agent_role_id).catch(() => {});

  await interaction.editReply({
    embeds: [baseEmbed.setDescription(`✅ You accepted the offer from ${offer.team_name}.`)],
    components: [disabledRowFrom(interaction.message)],
  });

  const newCount = nowCount + 1;
  const player = await interaction.client.users.fetch(offer.player_id).catch(() => null);
  const coach = await interaction.client.users.fetch(offer.coach_id).catch(() => null);
  const acceptEmbed = new EmbedBuilder()
    .setColor(offer.team_color || 0x5865f2)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
    .setTitle('✅ Transaction Complete ✅')
    .setDescription(
      `${player || `<@${offer.player_id}>`} \`${player ? player.username : offer.player_id}\` has accepted the offer from ${offer.team_emoji || ''} ${offer.team_name}\n\n` +
      `> 📁 Roster: ${newCount}/${offer.roster_size}\n` +
      `> 💼 Coach: ${coach || `<@${offer.coach_id}>`}`
    )
    .setTimestamp();
  if (offer.team_logo) acceptEmbed.setThumbnail(offer.team_logo);

  try {
    if (settings && settings.transaction_channel_id) {
      const channel = await guild.channels.fetch(settings.transaction_channel_id);
      await channel.send({ embeds: [acceptEmbed], allowedMentions: { users: [offer.player_id] } });
    }
  } catch {}
}

async function sweepExpiredOffers(client) {
  try {
    const rows = db.prepare('SELECT * FROM pending_offers WHERE status = ? AND expires_at < ?').all('pending', Date.now());
    for (const offer of rows) {
      db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offer.id);
      if (!offer.dm_channel_id || !offer.message_id) continue;
      try {
        const channel = await client.channels.fetch(offer.dm_channel_id);
        const message = await channel.messages.fetch(offer.message_id);
        if (message.components.length) await message.edit({ components: [disabledRowFrom(message)] });
      } catch {}
    }
  } catch (err) {
    console.error('[offerHandler] sweep error', err);
  }
}

function start(client) {
  setInterval(() => sweepExpiredOffers(client), 5 * 60 * 1000);
}

module.exports = { handleOfferButton, start };