const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('post_game_claim')
    .setDescription('Post a game for a referee, web streamer, and Discord streamer to claim')
    .addRoleOption(o => o.setName('away_team').setDescription('Away team role').setRequired(true))
    .addRoleOption(o => o.setName('home_team').setDescription('Home team role').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Game time (e.g. 8:00 PM EST)').setRequired(true))
    .addBooleanOption(o => o.setName('primetime').setDescription('Mark this as a Primetime game').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    if (!settings || !settings.game_claims_channel_id) {
      return interaction.reply({
        content: 'No game claims channel is set. Use /set_game_claims first.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const channel = await interaction.guild.channels.fetch(settings.game_claims_channel_id).catch(() => null);
    if (!channel) {
      return interaction.reply({
        content: 'The configured game claims channel no longer exists. Use /set_game_claims to set a new one.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const awayRole = interaction.options.getRole('away_team');
    const homeRole = interaction.options.getRole('home_team');
    const time = interaction.options.getString('time');
    const primetime = interaction.options.getBoolean('primetime') || false;

    // Persist the claim row FIRST so its id can be baked into the button customId -- same
    // reasoning as offers: the click handler (in index.js, always running) looks everything
    // up from this row, so it works no matter how many times the bot restarts before anyone
    // clicks Claim.
    const insert = db.prepare(
      `INSERT INTO game_claims (guild_id, away_role_id, home_role_id, time_text, primetime, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(interaction.guildId, awayRole.id, homeRole.id, time, primetime ? 1 : 0, Date.now());
    const claimId = insert.lastInsertRowid;

    const lines = [];
    if (primetime) lines.push('🌟 **PRIMETIME**');
    lines.push(`${awayRole} vs ${homeRole} • ${time}`);
    lines.push('');
    lines.push('**Referee:** Unclaimed');
    lines.push('**Web Streamer:** Unclaimed');
    lines.push('**Discord Streamer:** Unclaimed');

    const embed = new EmbedBuilder()
      .setColor(primetime ? 0xf1c40f : 0x5865f2)
      .setTitle(primetime ? 'Primetime Game' : 'Game')
      .setDescription(lines.join('\n'));

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_ref_${claimId}`).setLabel('Claim Referee').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`claim_webstream_${claimId}`).setLabel('Claim Web Streamer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`claim_discordstream_${claimId}`).setLabel('Claim Discord Streamer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`claim_lock_${claimId}`).setLabel('Lock').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_forceref_${claimId}`).setLabel('Force Drop Referee').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`claim_forcewebstream_${claimId}`).setLabel('Force Drop Web Streamer').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`claim_forcediscordstream_${claimId}`).setLabel('Force Drop Discord Streamer').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );

    let posted;
    try {
      posted = await channel.send({ embeds: [embed], components: [row1, row2] });
    } catch (err) {
      db.prepare('DELETE FROM game_claims WHERE id = ?').run(claimId);
      return interaction.reply({
        content: `I couldn't post in ${channel} -- check I have permission to send messages and embeds there.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: `✅ Posted in ${channel}: ${posted.url}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};