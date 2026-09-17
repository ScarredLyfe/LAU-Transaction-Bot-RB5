// Handles clicks on a posted game's buttons: Claim/Drop Referee, Claim/Drop Web Streamer,
// Claim/Drop Discord Streamer, Lock, and the three admin-only Force Drop buttons. Everything
// needed to process a click is looked up fresh from the game_claims table by the id baked
// into the button's customId (e.g. claim_ref_<id>, claim_forceref_<id>) -- same durable
// pattern as offerHandler.js, so a click works correctly no matter how many times the bot
// has restarted since the game was posted.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { db } = require('./database');

// The three claimable roles on a game. `field`/`statCol` are the DB columns; `label` is
// what shows in the embed and button text; `roleSetting` is which guild_settings column
// holds the role required to claim that slot.
const SLOTS = [
  { kind: 'ref',            field: 'referee_id',           statCol: 'referee_games',           label: 'Referee',         roleSetting: 'referee_role_id' },
  // Web Streamer and Discord Streamer are separate CLAIMS (a game can have one person doing
  // each, or the same person doing both), but they share a single "Streamer" ROLE
  // requirement -- anyone with the Streamer role can claim either slot.
  { kind: 'webstream',      field: 'web_streamer_id',      statCol: 'web_streamer_games',       label: 'Web Streamer',    roleSetting: 'streamer_role_id' },
  { kind: 'discordstream',  field: 'discord_streamer_id',  statCol: 'discord_streamer_games',   label: 'Discord Streamer',roleSetting: 'streamer_role_id' },
];

// claim_stats tracks each person's running total of games actually worked. Only incremented
// when a game is LOCKED (confirmed to have happened) -- see the lock branch below -- not at
// claim time, and only decremented if a lock is later undone.
function bumpStat(guildId, userId, column, delta) {
  db.prepare('INSERT OR IGNORE INTO claim_stats (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
  db.prepare(`UPDATE claim_stats SET ${column} = MAX(0, ${column} + ?) WHERE guild_id = ? AND user_id = ?`).run(delta, guildId, userId);
}
function getStat(guildId, userId, column) {
  const row = db.prepare(`SELECT ${column} AS v FROM claim_stats WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  return row ? row.v : 0;
}

function buildEmbed(claim, awayMention, homeMention) {
  const lines = [];
  if (claim.primetime) lines.push('🌟 **PRIMETIME**');
  lines.push(`${awayMention} vs ${homeMention}${claim.time_text ? ` • ${claim.time_text}` : ''}`);
  lines.push('');

  for (const slot of SLOTS) {
    const holderId = claim[slot.field];
    if (holderId) {
      const n = getStat(claim.guild_id, holderId, slot.statCol);
      lines.push(`**${slot.label}:** <@${holderId}> - ${n} Game${n === 1 ? '' : 's'}`);
    } else {
      lines.push(`**${slot.label}:** Unclaimed`);
    }
  }
  if (claim.locked) lines.push('\n🔒 **Locked**');

  return new EmbedBuilder()
    .setColor(claim.locked ? 0x2ecc71 : (claim.primetime ? 0xf1c40f : 0x5865f2))
    .setTitle(claim.primetime ? 'Primetime Game' : 'Game')
    .setDescription(lines.join('\n'));
}

function buildButtons(claim) {
  // Row 1: the three Claim/Drop buttons + Lock (4 buttons -- Discord allows up to 5/row).
  const row1 = new ActionRowBuilder().addComponents(
    ...SLOTS.map(slot => {
      const held = !!claim[slot.field];
      return new ButtonBuilder()
        .setCustomId(`claim_${slot.kind}_${claim.id}`)
        .setLabel(held ? `Drop ${slot.label}` : `Claim ${slot.label}`)
        .setStyle(held ? ButtonStyle.Danger : ButtonStyle.Primary)
        .setDisabled(!!claim.locked);
    }),
    new ButtonBuilder()
      .setCustomId(`claim_lock_${claim.id}`)
      .setLabel(claim.locked ? '🔓 Unlock' : 'Lock')
      .setStyle(claim.locked ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  // Row 2: the three admin-only Force Drop buttons.
  const row2 = new ActionRowBuilder().addComponents(
    ...SLOTS.map(slot =>
      new ButtonBuilder()
        .setCustomId(`claim_force${slot.kind}_${claim.id}`)
        .setLabel(`Force Drop ${slot.label}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!claim[slot.field] || !!claim.locked)
    ),
  );
  return [row1, row2];
}

async function handleClaimButton(interaction) {
  const [, kind, idStr] = interaction.customId.split('_'); // "claim_ref_5" / "claim_forceref_5" / "claim_lock_5"
  const claimId = parseInt(idStr, 10);

  await interaction.deferUpdate();

  const claim = db.prepare('SELECT * FROM game_claims WHERE id = ?').get(claimId);
  if (!claim) return;

  if (kind === 'lock') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      try { await interaction.followUp({ content: `Only a server manager can ${claim.locked ? 'unlock' : 'lock'} this.`, flags: MessageFlags.Ephemeral }); } catch {}
      return;
    }
    const nowLocking = !claim.locked;
    db.prepare('UPDATE game_claims SET locked = ? WHERE id = ?').run(nowLocking ? 1 : 0, claimId);
    const delta = nowLocking ? 1 : -1;
    for (const slot of SLOTS) {
      if (claim[slot.field]) bumpStat(claim.guild_id, claim[slot.field], slot.statCol, delta);
    }

  } else if (kind.startsWith('force')) {
    const slot = SLOTS.find(s => `force${s.kind}` === kind);
    if (!slot) return;
    if (claim.locked) {
      try { await interaction.followUp({ content: 'This game is locked and can\'t be changed.', flags: MessageFlags.Ephemeral }); } catch {}
      return;
    }
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      try { await interaction.followUp({ content: 'Only a server manager can force drop this.', flags: MessageFlags.Ephemeral }); } catch {}
      return;
    }
    const currentHolder = claim[slot.field];
    if (!currentHolder) return;
    const result = db.prepare(`UPDATE game_claims SET ${slot.field} = NULL WHERE id = ? AND ${slot.field} = ?`).run(claimId, currentHolder);
    if (result.changes === 0) return;

  } else {
    const slot = SLOTS.find(s => s.kind === kind);
    if (!slot) return;
    const currentHolder = claim[slot.field];

    if (claim.locked) {
      try { await interaction.followUp({ content: 'This game is locked and can\'t be changed.', flags: MessageFlags.Ephemeral }); } catch {}
      return;
    }

    if (currentHolder) {
      if (currentHolder !== interaction.user.id) {
        try {
          await interaction.followUp({
            content: `Only <@${currentHolder}> can drop this. A server manager can use Force Drop ${slot.label} instead.`,
            flags: MessageFlags.Ephemeral,
          });
        } catch {}
        return;
      }
      const result = db.prepare(
        `UPDATE game_claims SET ${slot.field} = NULL WHERE id = ? AND ${slot.field} = ?`
      ).run(claimId, currentHolder);
      if (result.changes === 0) return;
    } else {
      const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(claim.guild_id);
      const requiredRoleId = settings ? settings[slot.roleSetting] : null;
      if (requiredRoleId && !interaction.member.roles.cache.has(requiredRoleId)) {
        try {
          await interaction.followUp({
            content: `You need the ${slot.label} role to claim this.`,
            flags: MessageFlags.Ephemeral,
          });
        } catch {}
        return;
      }
      const result = db.prepare(
        `UPDATE game_claims SET ${slot.field} = ? WHERE id = ? AND ${slot.field} IS NULL`
      ).run(interaction.user.id, claimId);
      if (result.changes === 0) {
        try { await interaction.followUp({ content: 'Someone just claimed that a moment ago.', flags: MessageFlags.Ephemeral }); } catch {}
        return;
      }
    }
  }

  const updated = db.prepare('SELECT * FROM game_claims WHERE id = ?').get(claimId);
  const guild = interaction.guild;
  const awayRole = guild.roles.cache.get(updated.away_role_id);
  const homeRole = guild.roles.cache.get(updated.home_role_id);

  const embed = buildEmbed(updated, awayRole ? `${awayRole}` : '@unknown-team', homeRole ? `${homeRole}` : '@unknown-team');
  const rows = buildButtons(updated);

  await interaction.editReply({ embeds: [embed], components: rows });
}

module.exports = { handleClaimButton, buildEmbed, buildButtons, SLOTS };