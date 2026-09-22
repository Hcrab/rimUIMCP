using System.Threading;
using HarmonyLib;
using Verse;

namespace RimUIMCP;

internal static class RimBridgeDebugGamePause
{
    private sealed class PendingGame
    {
        public PendingGame(Game game, bool pauseOnLoad)
        {
            Game = game;
            PauseOnLoad = pauseOnLoad;
        }

        public Game Game { get; }

        public bool PauseOnLoad { get; }
    }

    private static PendingGame _pending;

    public static void Register(Game game, bool pauseOnLoad)
    {
        Interlocked.Exchange(ref _pending, new PendingGame(game, pauseOnLoad));
    }

    public static bool TryConsumeShouldPause(Game game)
    {
        var pending = Volatile.Read(ref _pending);
        if (pending == null || !ReferenceEquals(pending.Game, game))
            return false;

        return ReferenceEquals(Interlocked.CompareExchange(ref _pending, null, pending), pending)
            && pending.PauseOnLoad;
    }

    public static void ApplyAfterLoad(Game game)
    {
        var tickManager = game.tickManager;
        LongEventHandler.ExecuteWhenFinished(delegate
        {
            if (!ReferenceEquals(Current.Game, game)
                || tickManager == null
                || !ReferenceEquals(Find.TickManager, tickManager))
            {
                return;
            }

            tickManager.DoSingleTick();
            tickManager.CurTimeSpeed = TimeSpeed.Paused;
        });
    }
}

[HarmonyPatch(typeof(Game), nameof(Game.InitNewGame))]
internal static class Game_InitNewGame_RimBridgeDebugGamePause_Patch
{
    public static void Prefix(Game __instance, out bool __state)
    {
        __state = RimBridgeDebugGamePause.TryConsumeShouldPause(__instance);
    }

    public static void Postfix(Game __instance, bool __state)
    {
        if (__state)
            RimBridgeDebugGamePause.ApplyAfterLoad(__instance);
    }
}
