using HarmonyLib;
using RimWorld;

namespace RimUIMCP;

// World overlays (notably the route planner's Accept button) are drawn outside
// Window.InnerWindowOnGUI. Capture their actual controls in a dedicated surface.
[HarmonyPatch(typeof(WorldInterface), nameof(WorldInterface.WorldInterfaceOnGUI))]
internal static class RpWorldSurfacePatch
{
    private static void Prefix() => RimBridgeUiWorkbench.BeginCustomSurface("world.overlay", typeof(WorldInterface).FullName);
    private static void Postfix() => RimBridgeUiWorkbench.EndSurface();
}
