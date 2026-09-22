using System.Collections.Generic;
using System.Reflection.Emit;
using HarmonyLib;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

// Expose each original allowed-area selector. The game still handles its mouse event.
[HarmonyPatch(typeof(AreaAllowedGUI), "DoAreaSelector")]
internal static class RpAllowedAreaSelectorPatch
{
    internal sealed class State
    {
        public RpUiContext Scope;
        public RimBridgeUiWorkbench.UiPatchControlState Control;
    }

    private static void Prefix(Rect rect, Pawn p, Area area, out State __state)
    {
        var key = area?.ID.ToString() ?? "unrestricted";
        var label = AreaUtility.AreaAllowedLabel_Area(area);
        __state = new State { Scope = new RpUiContext("schedule.area", p.ThingID, key, label) };
        __state.Control = RimBridgeUiWorkbench.BeginCompoundControl("button", "rp.allowed_area", rect, label, key);
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect);
    }

    private static void Postfix(Pawn p, Area area, State __state)
    {
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control,
            p.playerSettings.AreaRestrictionInPawnCurrentMap == area,
            "Allowed area selection processed by original DoAreaSelector.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control);
        __state.Scope.Dispose();
    }

    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
    {
        var getButton = AccessTools.Method(typeof(Input), nameof(Input.GetMouseButton));
        var getEventType = AccessTools.PropertyGetter(typeof(Event), nameof(Event.type));
        foreach (var instruction in instructions)
        {
            if (instruction.Calls(getButton))
            {
                instruction.opcode = OpCodes.Call;
                instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.MouseButtonForActiveControl));
            }
            else if (instruction.Calls(getEventType))
            {
                // Unity may label the injected event Ignore inside a table group.
                // Reuse the existing targeted event bridge, which checks the live pointer.
                instruction.opcode = OpCodes.Call;
                instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.EventTypeForActiveControl));
            }
            yield return instruction;
        }
    }
}
