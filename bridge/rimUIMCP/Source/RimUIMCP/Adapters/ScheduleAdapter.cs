using System.Collections.Generic;
using System.Reflection.Emit;
using HarmonyLib;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(PawnColumnWorker_Timetable), "DoTimeAssignment")]
internal static class RpScheduleCellPatch
{
    internal sealed class State { public RpUiContext Scope; public RimBridgeUiWorkbench.UiPatchControlState Control; public TimeAssignmentDef Before; }
    private static void Prefix(Rect rect, Pawn p, int hour, out State __state) {
        __state = new State { Scope = new RpUiContext("schedule.hour", p.ThingID, hour.ToString()), Before = p.timetable.GetAssignment(hour) };
        __state.Control = RimBridgeUiWorkbench.BeginCompoundControl("schedule-cell", "rp.schedule_cell", rect, hour.ToString(), __state.Before.defName);
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect);
    }
    private static void Postfix(Pawn p, int hour, State __state) {
        var changed = p.timetable.GetAssignment(hour) != __state.Before;
        var alreadySelected = p.timetable.GetAssignment(hour) == TimeAssignmentSelector.selectedAssignment;
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control, changed || alreadySelected, "Schedule cell processed by original DoTimeAssignment.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control); __state.Scope.Dispose();
    }
    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
        var getButton = AccessTools.Method(typeof(Input), nameof(Input.GetMouseButton));
        foreach (var instruction in instructions) {
            if (instruction.Calls(getButton)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.MouseButtonForActiveControl)); }
            yield return instruction;
        }
    }
}
