using HarmonyLib;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using RimUIMCP.Sdk;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal static class RpLetterInput
{
    public static async Task WaitForStableIcon(int id, CancellationToken ct) {
        while (!await RimBridgeMainThread.InvokeAsync(() => {
            var letter = Find.LetterStack.LettersListForReading.FirstOrDefault(l => l.ID == id) ?? throw new RpException("TARGET_GONE", "Letter no longer appears in the stack.");
            var age = Time.time - letter.arrivalTime;
            return age >= 1f && !(letter.def.bounce && age > 15f && age % 5f < 1f);
        }, ct)) await RimBridge.Game.NextFrameAsync(ct);
    }
}

[HarmonyPatch(typeof(LetterStack), nameof(LetterStack.LettersOnGUI))]
internal static class RpLetterSurfacePatch
{
    private static void Prefix() => RimBridgeUiWorkbench.BeginCustomSurface("main.letters", typeof(LetterStack).FullName);
    private static void Postfix() => RimBridgeUiWorkbench.EndSurface();
}

[HarmonyPatch(typeof(Letter), nameof(Letter.DrawButtonAt))]
internal static class RpLetterScopePatch
{
    private static void Prefix(Letter __instance, out RpUiContext __state) => __state = new RpUiContext(
        "letter.open." + __instance.ID, RpSession.Reference(__instance).id, __instance.ID.ToString(), __instance.Label.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}
