// ServCrafty Bots: spawn survivor bots of a chosen character on a Left 4 Dead 2 server.
//
// The game's own `sb_add` always picks the character itself, so the panel could only add duplicates. This plugin adds a bot
// the way the game does and then gives it the character, model and name asked for, including the four Left 4 Dead 1
// survivors. The panel talks to it over RCON:
//
//   sc_survivors            lists the survivors:   SCSURV <userid> <character 0-7 or -1> <bot 0|1> <name>
//   sc_addbot <id|name>     adds one survivor bot: SCOK <userid> <name>   or   SCERR <reason>
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

	// The team size is capped by survivor_limit: make room for one more (up to 16, as the Multiplayer plugin does).
	ConVar limit = FindConVar("survivor_limit");
	if (limit != null)
	{
		limit.SetBounds(ConVarBound_Upper, true, float(MAX_SURVIVORS));
		if (limit.IntValue < count + 1)
		{
			limit.IntValue = count + 1;
		}
	}

	bool before[MAXPLAYERS + 1];
	for (int i = 1; i <= MaxClients; i++)
	{
		before[i] = IsSurvivor(i);
	}

	// sb_add is a cheat command: lift the flag for this one call.
	int flags = GetCommandFlags("sb_add");
	SetCommandFlags("sb_add", flags & ~FCVAR_CHEAT);
	ServerCommand("sb_add");
	ServerExecute();
	SetCommandFlags("sb_add", flags);

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
