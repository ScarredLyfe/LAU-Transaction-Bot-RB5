require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const { setWebsiteDisplayName } = require('./firebaseSync');
const { db, ready } = require('./database');
const verifyWatcher = require('./verifyWatcher');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://laurb5.com';

// Is this Discord user fully registered on the website (discordId + robloxId both linked)?
async function isRegistered(discordId) {
  console.log(`[verify-btn] checking registration for ${discordId} against ${FB}`);
  try {
    const res = await fetch(`${FB}/data/playerdb.json`);
    const pdb = await res.json();
    if (Array.isArray(pdb)) {
      console.log(`[verify-btn] playerdb loaded: ${pdb.length} entries`);
      const hit = pdb.find(p => p && String(p.discordId || '') === String(discordId) && String(p.robloxId || '').trim());
      if (hit) { console.log(`[verify-btn] MATCH in playerdb: ${hit.name}`); return true; }
      console.log(`[verify-btn] no playerdb entry with discordId=${discordId} + robloxId`);
    } else {
      console.log(`[verify-btn] playerdb was not an array (got ${typeof pdb}) — data path or URL may be wrong`);
    }
  } catch (e) { console.error('[verify-btn] playerdb fetch failed:', e.message); }
  try {
    const accts = await (await fetch(`${FB}/accounts.json`)).json();
    if (accts && typeof accts === 'object') {
      const ok = Object.values(accts).some(a => a && String(a.discordId || '') === String(discordId) && String(a.robloxId || '').trim());
      console.log(`[verify-btn] accounts check for ${discordId}: ${ok ? 'MATCH' : 'no match'} (${Object.keys(accts).length} accounts)`);
      return ok;
    } else {
      console.log(`[verify-btn] accounts was not an object (got ${typeof accts})`);
    }
  } catch (e) { console.error('[verify-btn] accounts fetch failed:', e.message); }
  return false;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  }
}

// Auto-register all slash commands on startup, so any command change goes live on deploy.
client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    const { REST, Routes } = require('discord.js');
    const cmds = [];
    for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
      const command = require(path.join(commandsPath, file));
      if ('data' in command) cmds.push(command.data.toJSON());
    }
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: cmds },
    );
    console.log(`Registered ${cmds.length} slash commands.`);
  } catch (err) {
    console.error('Command registration failed:', err);
  }
  console.log(`[data] bot is reading/writing data at: ${FB}`);
  verifyWatcher.start(c);
  try { require('./scorePublisher').start(c); } catch (err) { console.error('Score publisher failed to start:', err); }
  try { require('./offerHandler').start(c); } catch (err) { console.error('Offer sweep failed to start:', err); }
  try { require('./franchiseBoard').start(c); } catch (err) { console.error('Franchise board failed to start:', err); }
});

client.on(Events.InteractionCreate, async interaction => {
  // Autocomplete (e.g. /promote coach picker showing live role names)
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command && command.autocomplete) {
      try { await command.autocomplete(interaction); } catch (err) { console.error('Autocomplete error:', err); }
    }
    return;
  }

  // Offer Accept/Deny buttons — handled globally so they survive bot restarts.
  if (interaction.isButton() && /^offer_(accept|deny)_\d+$/.test(interaction.customId)) {
    try {
      await require('./offerHandler').handleOfferButton(interaction);
    } catch (err) {
      console.error('Offer button error:', err);
      try { if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate(); } catch {}
    }
    return;
  }

  // Game claim buttons (Referee / Web Streamer / Discord Streamer / Lock / Force Drops) —
  // handled globally, same durable reasoning as offers.
  if (interaction.isButton() && /^claim_(ref|webstream|discordstream|lock|forceref|forcewebstream|forcediscordstream)_\d+$/.test(interaction.customId)) {
    try {
      await require('./gameClaimHandler').handleClaimButton(interaction);
    } catch (err) {
      console.error('Game claim button error:', err);
      try { if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate(); } catch {}
    }
    return;
  }

  // Verify button on the verification panel
  if (interaction.isButton() && interaction.customId === 'verify_btn') {
    try {
      const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
      const registered = await isRegistered(interaction.user.id);

      if (registered) {
        // Already registered on the website → grant roles right now.
        const member = interaction.member;
        const toAdd = [];
        if (settings && settings.verified_role_id)   toAdd.push(settings.verified_role_id);
        if (settings && settings.free_agent_role_id) toAdd.push(settings.free_agent_role_id);
        try { if (toAdd.length) await member.roles.add(toAdd, 'Verified via panel'); } catch (e) { console.error('[verify] button add roles failed', e); }
        try {
          if (settings && settings.unverified_role_id && member.roles.cache.has(settings.unverified_role_id)) {
            await member.roles.remove(settings.unverified_role_id, 'Verified');
          }
        } catch (e) { console.error('[verify] button remove unverified failed', e); }
        await interaction.reply({ content: '✅ You\'re verified! You now have access to the rest of the server.', flags: 1 << 6 });
      } else {
        // Not registered yet → send them to the website. The watcher will role them
        // automatically within a few seconds of finishing registration.
        await interaction.reply({
          content: `You're not registered yet. Head to ${WEBSITE_URL} and link your Discord + Roblox to register.\n\nOnce you're done, you'll be verified automatically — or just click **Verify** again.`,
          flags: 1 << 6,
        });
      }
    } catch (err) {
      console.error('Verify button error:', err);
      try { await interaction.reply({ content: 'Something went wrong verifying you. Try again in a moment.', flags: 1 << 6 }); } catch {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong running that command.', flags: 1 << 6 };
    try {
      if (interaction.deferred) await interaction.editReply(msg);
      else if (interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

// Auto-update the website display name whenever someone's server nickname changes,
// so player profile names on the site always match their Discord server name.
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const oldName = oldMember.nickname || (oldMember.user && oldMember.user.globalName) || (oldMember.user && oldMember.user.username);
    const newName = newMember.nickname || (newMember.user && newMember.user.globalName) || (newMember.user && newMember.user.username);
    if (oldName !== newName) {
      await setWebsiteDisplayName(newMember.id, newMember).catch(() => {});
    }
  } catch (err) {
    console.error('Nickname auto-update failed:', err);
  }
});

// Give new members the unverified role automatically until they register.
client.on(Events.GuildMemberAdd, async member => {
  try {
    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(member.guild.id);
    if (settings && settings.unverified_role_id) {
      await member.roles.add(settings.unverified_role_id, 'New member — not yet verified').catch(() => {});
    }
  } catch (err) {
    console.error('Auto-unverified-role failed:', err);
  }
});

client.on('error', err => console.error('Client error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// Wait for the initial data load from Firebase, then log in.
(async () => {
  try { await ready; } catch (e) { console.error('[db] initial load error', e); }
  client.login(process.env.DISCORD_TOKEN);
})();