require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const { setWebsiteDisplayName } = require('./firebaseSync');
const { ready } = require('./database');

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

client.on('error', err => console.error('Client error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// Wait for the initial data load from Firebase, then log in.
(async () => {
  try { await ready; } catch (e) { console.error('[db] initial load error', e); }
  client.login(process.env.DISCORD_TOKEN);
})();
