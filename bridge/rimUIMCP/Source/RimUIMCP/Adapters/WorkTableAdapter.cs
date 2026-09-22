using HarmonyLib;
using System.Collections.Generic;
using System.Reflection.Emit;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(WidgetsWork), nameof(WidgetsWork.DrawWorkBoxFor))]
internal static class RpWorkCellPatch
{
    // Unity can filter a control-local injected event to Ignore after a scroll clip was built.
    // Expose the injected phase only to this visible, unblocked control's original event branch.
    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
        var getter = AccessTools.PropertyGetter(typeof(Event), nameof(Event.type));
        foreach (var instruction in instructions) {
            if (instruction.Calls(getter)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.EventTypeForActiveControl)); }
            yield return instruction;
        }
    }
    internal sealed class State { public RpUiContext Scope; public RimBridgeUiWorkbench.UiPatchControlState Control; public int Before; }
    private static void Prefix(float x, float y, Pawn p, WorkTypeDef wType, out State __state) {
        var rect = new Rect(x, y, 25, 25);
        __state = new State { Scope = new RpUiContext("work.priority", p.ThingID, wType.defName), Before = p.workSettings?.GetPriority(wType) ?? 0 };
        __state.Control = RimBridgeUiWorkbench.BeginCompoundControl("work-cell", "rp.work_cell", rect, wType.labelShort,
            __state.Before.ToString(), disabled: p.WorkTypeIsDisabled(wType));
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect);
    }
    private static void Postfix(Pawn p, WorkTypeDef wType, State __state) {
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control, p.workSettings?.GetPriority(wType) != __state.Before, "Work priority changed through DrawWorkBoxFor mouse handling.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control); __state.Scope.Dispose();
    }
}
