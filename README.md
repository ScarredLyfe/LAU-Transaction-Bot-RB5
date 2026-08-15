# Transaction Bot — linked to the website's Firebase

This Discord transaction/roster bot is linked to your website exactly the way the
LAU reference bot is: every roster change in Discord is pushed to the same Firebase
database the website reads from.

## What "linked" means here

The file `firebaseSync.js` writes to the website's Firebase:

- **Rosters** → `rosters/season_<id>/rosters[ABBR] = [names]`
- **Coach/owner slots** → `rosters/season_<id>/staffRoles[ABBR] = { owner, gm, hc }`
- **Player profile names** → `data/playerdb[i].displayName` (their Discord server name)

The bot's OWN data (its settings, teams, players) is also stored in Firebase under
`BOT_DB_KEY` (see `database.js`), so the bot is stateless and can run on any host.

## Which commands do what (on the website)

| Command    | Website effect                                                        |
|------------|-----------------------------------------------------------------------|
| `/appoint` | Adds the user to that team's roster + sets them as **owner**          |
| `/offer` (accepted) | Adds the player to that team's roster                        |
| `/promote` | Sets the player in the **gm** (Coach 1) or **hc** (Coach 2) slot     |
| `/demote`  | Clears that staff slot (player stays on the roster)                   |
| `/demand`  | Removes the player from their team's roster (becomes a free agent)    |
| `/release` | Removes the player from their team's roster                          |
| `/disband` | Removes **every** player on the team from their roster                |
| `/sync`    | Rebuilds all rosters + coach slots + names from current Discord roles |

Becoming a free agent = being removed from the website roster. All three of
`/demand`, `/release`, and `/disband` go through `makeFreeAgent()` in `freeAgent.js`,
which removes the player from the website roster automatically.

## Player names come from Discord

- On assignment, the bot stores the player's Discord server name as `displayName`.
- Whenever someone changes their server nickname, the bot updates `displayName`
  automatically (the `GuildMemberUpdate` listener in `index.js`).

## Season lock

A season is **locked** when its status is `finished` in `data/seasonMeta`.
While a season is locked, the bot will NOT change that season's rosters or staff —
adds and removes are skipped. (Name/label updates are still allowed, since they only
change how a name is displayed, not who is on a roster.) This matches how the website
treats a finished season.

## Setup

1. Install Node.js 22 or newer (needs the built-in `node:sqlite`).
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in:
   - `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` from the Discord Developer Portal.
   - `FIREBASE_URL` — the SAME Firebase your website uses
     (`https://lau-website-default-rtdb.firebaseio.com`).
   - `BOT_DB_KEY` — a unique key for THIS bot (e.g. `bot_db_transactions`).
4. In the Developer Portal → your app → Bot, enable the **Server Members Intent**.
5. `npm start`

On startup the bot loads its data from Firebase, registers its slash commands to your
guild, and logs in.

## First-time league setup (in Discord)

Run these once so the bot knows your teams and roles:

- `/addteam` — register each team (its role + name + emoji). The team **name** must
  match a `name` in the website's `data/team_defs` so rosters map to the right abbr.
- `/set_coaches` — set the Owner / Coach 1 / Coach 2 roles.
- `/set_transaction_channel`, `/set_roster_size`, `/set_max_demands`,
  `/set_signed_role`, `/set_free_agent_role` — as needed.
- `/sync` — backfill rosters, coach slots, and names onto the website from current roles.
