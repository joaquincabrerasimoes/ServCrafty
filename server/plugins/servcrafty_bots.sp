// ServCrafty Bots: spawn survivor bots of a chosen character on a Left 4 Dead 2 server.
//
// The game's own `sb_add` (and the Multiplayer plugin's `sm_setmax`) always pick the character itself, so the panel could only add duplicates. This plugin adds a bot
// the way the game does and then gives it the character, model and name asked for, including the four Left 4 Dead 1
// survivors. The panel talks to it over RCON:
//
//   sc_survivors            lists the survivors:   SCSURV <userid> <character 0-7 or -1> <bot 0|1> <name>
//   sc_addbot <id|name>     adds one survivor bot: SCOK <userid> <name>   or   SCERR <reason>
//   sc_spawn <kind> [n]     spawns a horde or special infected: SCOK <kind> <n>   or   SCERR <reason>
//                           kinds: panic (a horde event), mob (a common horde), smoker, boomer, hunter, spitter, jockey, charger, tank, witch
//
// Character ids are the game's own (m_survivorCharacter): 0 Nick, 1 Rochelle, 2 Coach, 3 Ellis, 4 Bill, 5 Zoey, 6 Francis, 7 Louis.
// Build: spcomp servcrafty_bots.sp (SourceMod 1.12). The compiled servcrafty_bots.smx is shipped next to this file.

#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>

#define TEAM_SURVIVOR 2
#define CHARACTERS 8
#define MAX_SURVIVORS 16

public Plugin myinfo =
{
	name = "ServCrafty Bots",
	author = "ServCrafty",
	description = "Spawn survivor bots of a chosen character (Left 4 Dead 2 and Left 4 Dead 1 survivors)",
	version = "1.0.0",
	url = "https://github.com/joaquincabrerasimoes/ServCrafty"
};

static const char g_Names[CHARACTERS][] = { "Nick", "Rochelle", "Coach", "Ellis", "Bill", "Zoey", "Francis", "Louis" };

static const char g_Models[CHARACTERS][] =
{
	"models/survivors/survivor_gambler.mdl",
	"models/survivors/survivor_producer.mdl",
	"models/survivors/survivor_coach.mdl",
	"models/survivors/survivor_mechanic.mdl",
	"models/survivors/survivor_namvet.mdl",
	"models/survivors/survivor_teenangst.mdl",
	"models/survivors/survivor_biker.mdl",
	"models/survivors/survivor_manager.mdl"
};

public void OnPluginStart()
{
	RegServerCmd("sc_survivors", Cmd_Survivors, "List the survivors and their characters");
	RegServerCmd("sc_spawn", Cmd_Spawn, "sc_spawn <panic|mob|smoker|boomer|hunter|spitter|jockey|charger|tank|witch> [count]: spawn a horde or special infected");
	RegServerCmd("sc_addbot", Cmd_AddBot, "sc_addbot <0-7|name>: add a survivor bot of that character");
}

public void OnMapStart()
{
	// SetEntityModel crashes the server with a model that was not precached.
	for (int i = 0; i < CHARACTERS; i++)
	{
		PrecacheModel(g_Models[i], true);
	}
}

bool IsSurvivor(int client)
{
	return client > 0 && client <= MaxClients && IsClientInGame(client) && GetClientTeam(client) == TEAM_SURVIVOR;
}

int CharacterOf(int client)
{
	int c = GetEntProp(client, Prop_Send, "m_survivorCharacter");
	return (c >= 0 && c < CHARACTERS) ? c : -1;
}

int CountSurvivors()
{
	int n = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (IsSurvivor(i))
		{
			n++;
		}
	}
	return n;
}

// "3", "ellis", "Louis" -> character id, or -1
int ParseCharacter(const char[] arg)
{
	if (arg[0] >= '0' && arg[0] <= '9' && arg[1] == '\0')
	{
		int id = StringToInt(arg);
		return (id >= 0 && id < CHARACTERS) ? id : -1;
	}
	for (int i = 0; i < CHARACTERS; i++)
	{
		if (StrEqual(arg, g_Names[i], false))
		{
			return i;
		}
	}
	if (StrEqual(arg, "Luis", false))
	{
		return 7;
	}
	return -1;
}

public Action Cmd_Survivors(int args)
{
	int shown = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsSurvivor(i))
		{
			continue;
		}
		char name[MAX_NAME_LENGTH];
		GetClientName(i, name, sizeof(name));
		PrintToServer("SCSURV %d %d %d %s", GetClientUserId(i), CharacterOf(i), IsFakeClient(i) ? 1 : 0, name);
		shown++;
	}
	PrintToServer("SCEND %d", shown);
	return Plugin_Handled;
}

public Action Cmd_AddBot(int args)
{
	if (args < 1)
	{
		PrintToServer("SCERR usage");
		return Plugin_Handled;
	}
	char arg[32];
	GetCmdArg(1, arg, sizeof(arg));
	int character = ParseCharacter(arg);
	if (character < 0)
	{
		PrintToServer("SCERR unknown_character");
		return Plugin_Handled;
	}

	int count = CountSurvivors();
	if (count >= MAX_SURVIVORS)
	{
		PrintToServer("SCERR team_full");
		return Plugin_Handled;
	}

	bool before[MAXPLAYERS + 1];
	for (int i = 1; i <= MaxClients; i++)
	{
		before[i] = IsSurvivor(i);
	}

	// sb_add refuses to go past survivor_limit (4) and the Multiplayer plugin (l4d2_rmc) keeps that limit to itself,
	// so ask that plugin for a team one survivor bigger: it creates the bot. Fall back to sb_add if it is not there.
	if (GetCommandFlags("sm_setmax") != INVALID_FCVAR_FLAGS)
	{
		ServerCommand("sm_setmax %d", count + 1);
		ServerExecute();
	}
	else
	{
		int flags = GetCommandFlags("sb_add");
		SetCommandFlags("sb_add", flags & ~FCVAR_CHEAT);
		ServerCommand("sb_add");
		ServerExecute();
		SetCommandFlags("sb_add", flags);
	}

	int bot = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!before[i] && IsSurvivor(i) && IsFakeClient(i))
		{
			bot = i;
			break;
		}
	}
	if (bot == 0)
	{
		PrintToServer("SCERR no_bot");
		return Plugin_Handled;
	}

	SetEntProp(bot, Prop_Send, "m_survivorCharacter", character);
	SetEntityModel(bot, g_Models[character]);
	SetClientName(bot, g_Names[character]);
	PrintToServer("SCOK %d %s", GetClientUserId(bot), g_Names[character]);
	return Plugin_Handled;
}

// Runs a cheat command as `client` (z_spawn_old places the infected out of sight of that survivor) with the cheat flag lifted for the call.
void RunCheat(int client, const char[] command, const char[] args)
{
	int flags = GetCommandFlags(command);
	if (flags == INVALID_FCVAR_FLAGS)
	{
		return;
	}
	SetCommandFlags(command, flags & ~FCVAR_CHEAT);
	FakeClientCommand(client, "%s %s", command, args);
	SetCommandFlags(command, flags);
}

int CountInfected()
{
	int n = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (IsClientInGame(i) && GetClientTeam(i) == 3)
		{
			n++;
		}
	}
	return n;
}

// The survivor the infected are spawned around: a living player, else any living survivor.
int SpawnAnchor()
{
	int bot = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (IsSurvivor(i) && IsPlayerAlive(i))
		{
			if (!IsFakeClient(i))
			{
				return i;
			}
			bot = i;
		}
	}
	return bot;
}

public Action Cmd_Spawn(int args)
{
	if (args < 1)
	{
		PrintToServer("SCERR usage");
		return Plugin_Handled;
	}
	char kind[16];
	GetCmdArg(1, kind, sizeof(kind));
	int count = 1;
	if (args >= 2)
	{
		char num[8];
		GetCmdArg(2, num, sizeof(num));
		count = StringToInt(num);
	}
	if (count < 1 || count > 10)
	{
		PrintToServer("SCERR bad_count");
		return Plugin_Handled;
	}

	int anchor = SpawnAnchor();
	if (anchor == 0)
	{
		PrintToServer("SCERR no_survivor");
		return Plugin_Handled;
	}

	if (StrEqual(kind, "panic", false))
	{
		int flags = GetCommandFlags("director_force_panic_event");
		SetCommandFlags("director_force_panic_event", flags & ~FCVAR_CHEAT);
		ServerCommand("director_force_panic_event");
		ServerExecute();
		SetCommandFlags("director_force_panic_event", flags);
		PrintToServer("SCOK panic 1");
		return Plugin_Handled;
	}

	bool special = StrEqual(kind, "smoker", false) || StrEqual(kind, "boomer", false) || StrEqual(kind, "hunter", false) || StrEqual(kind, "spitter", false)
		|| StrEqual(kind, "jockey", false) || StrEqual(kind, "charger", false) || StrEqual(kind, "tank", false);
	if (!special && !StrEqual(kind, "mob", false) && !StrEqual(kind, "witch", false))
	{
		PrintToServer("SCERR unknown_kind");
		return Plugin_Handled;
	}

	char spawnArgs[32];
	Format(spawnArgs, sizeof(spawnArgs), "%s auto", kind);
	int before = CountInfected();
	for (int n = 0; n < count; n++)
	{
		RunCheat(anchor, "z_spawn_old", spawnArgs);
	}
	// Specials and tanks are players of the infected team: if none appeared, the game found no place to put them.
	if (special && CountInfected() <= before)
	{
		PrintToServer("SCERR no_spawn");
		return Plugin_Handled;
	}
	PrintToServer("SCOK %s %d", kind, special ? CountInfected() - before : count);
	return Plugin_Handled;
}
