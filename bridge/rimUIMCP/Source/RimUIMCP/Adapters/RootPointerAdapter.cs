using HarmonyLib;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(Root), nameof(Root.OnGUI))]
internal static class RpRootPointerPatch
{
    private static void Prefix(out RimBridgeUiWorkbench.RootPointerState __state) => __state = RimBridgeUiWorkbench.BeginRootPointer();
    private static void Postfix(RimBridgeUiWorkbench.RootPointerState __state) => RimBridgeUiWorkbench.EndRootPointer(__state);
}
