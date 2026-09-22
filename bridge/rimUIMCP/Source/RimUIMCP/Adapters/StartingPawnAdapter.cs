using HarmonyLib;
using System.Collections.Generic;
using System.Reflection.Emit;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

// Starting pawn rows use a direct MouseDown check instead of a Widgets button.
// Keep the injected event alive across that original check; never set the index.
[HarmonyPatch(typeof(Page_ConfigureStartingPawns), "DrawPawnList")]
internal static class RpStartingPawnRows
{
    internal static Page_ConfigureStartingPawns Page;
    internal static int Row;
    private static RimBridgeUiWorkbench.UiPatchControlState control;
    private static RpUiContext scope;
    private static void Prefix(Page_ConfigureStartingPawns __instance) { Page = __instance; Row = 0; }
    private static void Finalizer() { EndRow(); Page = null; }
    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
        var getter = AccessTools.PropertyGetter(typeof(Event), nameof(Event.type));
        foreach (var instruction in instructions) {
            // Unity scroll clips can filter a locally injected click to Ignore.
            // Reuse the same pointer-checked event bridge as the real work table.
            if (instruction.Calls(getter)) {
                instruction.opcode = OpCodes.Call;
                instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.EventTypeForActiveControl));
            }
            yield return instruction;
        }
    }
    internal static void BeginRow(Rect rect) {
        if (Page == null || Row >= Find.GameInitData.startingAndOptionalPawns.Count) return;
        var pawn = Find.GameInitData.startingAndOptionalPawns[Row];
        scope = new RpUiContext("setup.pawn.select", pawn.ThingID, Row.ToString(), pawn.LabelShort);
        control = RimBridgeUiWorkbench.BeginCompoundControl("button", "rp.starting_pawn", rect, pawn.LabelShort);
        RimBridgeUiWorkbench.PrepareControlInteraction(control, rect);
    }
    internal static void EndRow() {
        if (control == null) return;
        RimBridgeUiWorkbench.ObserveControlResult(control, Page != null && Page.curPawnIndex == Row,
            "Starting pawn selected through the original row MouseDown handler.");
        RimBridgeUiWorkbench.EndCompoundControl(control);
        scope?.Dispose(); scope = null; control = null; Row++;
    }
}

[HarmonyPatch(typeof(Widgets), nameof(Widgets.DrawOptionBackground))]
internal static class RpStartingPawnRowBegin
{
    private static void Prefix(Rect rect) => RpStartingPawnRows.BeginRow(rect);
}

[HarmonyPatch(typeof(ReorderableWidget), nameof(ReorderableWidget.Reorderable))]
internal static class RpStartingPawnRowEnd
{
    private static void Prefix() { if (RpStartingPawnRows.Page != null) RpStartingPawnRows.EndRow(); }
}
