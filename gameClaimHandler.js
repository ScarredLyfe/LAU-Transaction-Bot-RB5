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

// Games-worked totals are counted straight from the locked claims themselves, not from
// running counters. Counters split streaming into two separate numbers (web vs Discord), so
// someone who web streamed one game and Discord streamed another saw "1 Game" on each instead
// of the 2 they actually streamed. Counting locked game_claims rows directly gives the real
// total, counts doing BOTH streams on the same game as one game streamed, and can never drift
// out of sync after an unlock/relock -- there's no counter to forget to reverse.
// (claim_stats is still updated below for backward compatibility, but nothing displays it.)
function bumpStat(guildId, userId, column, delta) {
  db.prepare('INSERT OR IGNORE INTO claim_stats (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
  db.prepare(`UPDATE claim_stats SET ${column} = MAX(0, ${column} + ?) WHERE guild_id = ? AND user_id = ?`).run(delta, guildId, userId);
}
function gamesReffed(guildId, userId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM game_claims WHERE guild_id = ? AND locked = 1 AND referee_id = ?'
  ).get(guildId, userId).n;
}
function gamesStreamed(guildId, userId) {
  // Either streaming role counts; the OR means a game where they did both counts once.
  return db.prepare(
    'SELECT COUNT(*) AS n FROM game_claims WHERE guild_id = ? AND locked = 1 AND (web_streamer_id = ? OR discord_streamer_id = ?)'
  ).get(guildId, userId, userId).n;
}

function buildEmbed(claim, awayMention, homeMention) {
  const lines = [];
  if (claim.primetime) lines.push('🌟 **PRIMETIME**');
  lines.push(`${awayMention} vs ${homeMention}${claim.time_text ? ` • ${claim.time_text}` : ''}`);
  lines.push('');

  for (const slot of SLOTS) {
    const holderId = claim[slot.field];
    if (holderId) {
      const isRef = slot.kind === 'ref';
      const n = isRef ? gamesReffed(claim.guild_id, holderId) : gamesStreamed(claim.guild_id, holderId);
      lines.push(`**${slot.label}:** <@${holderId}> - ${n} Game${n === 1 ? '' : 's'} ${isRef ? 'Reffed' : 'Streamed'}`);
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
    // Toggles both ways. Locking is also what actually confirms the game happened, so THIS
    // is when each stat column gets incremented for whoever currently holds that slot -- not
    // at claim time. Claiming a slot no longer bumps the stat by itself, since a
    // claimed-but-never-locked game (cancelled, swapped out, etc.) shouldn't have counted
    // toward anyone's total just because they clicked. Unlocking reverses the same increment.
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
    // ── Server-manager-only force drop -- always requires Manage Server, regardless of who
    // holds the slot. Only reachable while unlocked (the button is disabled once locked), so
    // the slot was never counted toward anyone's total yet -- nothing to reverse here.
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
    if (!currentHolder) return; // nothing to drop -- button should be disabled anyway
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
      // ── DROP ── self-only. A server manager who needs to free a stuck slot uses the
      // separate Force Drop button instead. Only reachable while unlocked, so this claim
      // was never counted toward their total yet -- nothing to reverse here.
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
      if (result.changes === 0) return; // state already changed under us -- nothing to do
    } else {
      // ── CLAIM ── requires the configured role, if one is set for this server. Claiming
      // itself doesn't touch the stat column anymore -- that only happens when the game is
      // actually locked (confirmed).
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
      // Atomic claim: only succeeds if the field is still NULL at this exact moment -- if
      // two people click within the same instant, only the first actually wins the slot.
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

module.exports = { handleClaimButton, buildEmbed, buildButtons, SLOTS, gamesReffed, gamesStreamed };