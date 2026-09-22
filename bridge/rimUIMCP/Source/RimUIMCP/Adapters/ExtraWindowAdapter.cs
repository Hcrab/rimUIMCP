using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Verse;

namespace RimUIMCP;

// Full-screen pages (including starting-site selection) draw buttons outside
// InnerWindowOnGUI. Keep that real callback as its own surface and control order.
[HarmonyPatch]
internal static class RpExtraWindowSurfacePatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(Window).Assembly.GetTypes()
        .Where(t => !t.IsAbstract && typeof(Window).IsAssignableFrom(t))
        .Select(t => t.GetMethod(nameof(Window.ExtraOnGUI), BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
        .Where(m => m != null && !m.IsAbstract);
    private static void Prefix(Window __instance) => RimBridgeUiWorkbench.BeginCustomSurface("window-extra:" + __instance.ID + ":" + __instance.GetType().FullName, __instance.GetType().FullName);
    private static void Postfix() => RimBridgeUiWorkbench.EndSurface();
}
