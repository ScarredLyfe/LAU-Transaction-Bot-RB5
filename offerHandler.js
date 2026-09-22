// Handles clicks on an offer's Accept/Deny buttons. Called from index.js's GLOBAL
// InteractionCreate listener (always running) — NOT from a per-message collector tied to
// one bot process. Every button encodes the offer's database row id in its customId
// (offer_accept_<id> / offer_deny_<id>), and everything needed to process it is looked up
// fresh from the `pending_offers` table. This means a click is handled correctly even if
// the bot restarted any number of times since the offer was sent — nothing relies on
// in-memory state tied to a specific process run, which is what caused the old
// collector-based version to intermittently show "This interaction failed."
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
  const [, action, idStr] = interaction.customId.split('_'); // "offer_accept_42" -> ["offer","accept","42"]
  const offerId = parseInt(idStr, 10);

  // Acknowledge FIRST, before any other work — this is what actually prevents "Interaction
  // failed": Discord needs an ack within 3 seconds, and deferring immediately guarantees
  // that regardless of how long the database/role/website work below takes.
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

  // Atomically claim the offer before the slower async work below. If two clicks land close
  // together (double-click), whichever UPDATE flips 'pending' -> 'processing' wins; the loser
  // sees changes === 0 and backs off instead of also granting the roster spot.
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

  // Read the CURRENT roster cap, not offer.roster_size -- that column is a snapshot of
  // whatever the cap was the moment /offer was run, so if an admin changes it afterward
  // (before this offer is accepted), checking against the frozen value would use a stale
  // cap instead of the real one.
  const currentSettings = db.prepare('SELECT roster_size FROM guild_settings WHERE guild_id = ?').get(offer.guild_id);
  const currentCap = (currentSettings && currentSettings.roster_size) || offer.roster_size;
  const nowCount = db.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?'
  ).get(offer.guild_id, offer.team_id).c;
  if (nowCount >= currentCap) {
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

  // If they're already on a team by the time they accept (signed elsewhere in the meantime),
  // don't double-sign them.
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

  // Website sync: add to the team's roster + store their Discord name.
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
      `> 📁 Roster: ${newCount}/${currentCap}\n` +
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

// Periodic cosmetic cleanup: disable buttons on offers that expired while nobody clicked.
// Not required for correctness (a click on an expired offer is handled safely above).
async function sweepExpiredOffers(client) {
  try {
    const rows = db.prepare('SELECT * FROM pending_offers WHERE status = ? AND expires_at < ?').all('pending', Date.now());
    for (const offer of rows) {
      db.prepare('UPDATE pending_offers SET status = ? WHERE id = ?').run('expired', offer.id);
      if (!offer.dm_channel_id || !offer.message_id) continue;
      try {
        const channel = await client.channels.fetch(offer.dm_channel_id);
        const message = await channel.messages.fetch(offer.message_id);
        if (message.components.length) {
          await message.edit({ components: [disabledRowFrom(message)] });
        }
      } catch {}
    }
  } catch (err) {
    console.error('[offerHandler] sweep error', err);
  }
}

function start(client) {
  setInterval(() => sweepExpiredOffers(client), 5 * 60 * 1000); // every 5 minutes
}

module.exports = { handleOfferButton, start };