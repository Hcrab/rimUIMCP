using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;
using UnityEngine;
using Verse;

namespace RimUIMCP;

// Only the GUI text control's return value is supplied. The caller's validation/parsing still runs.
internal static class RpFormAdapter
{
    public static RimBridgeUiWorkbench.UiPatchControlState Begin(Rect rect, string text) {
        var state = RimBridgeUiWorkbench.BeginCompoundControl("text_field", "gui.text_field", rect, valueText: text, disabled: !GUI.enabled);
        if (!RimBridgeUiWorkbench.TryGetFormInput(state, out _)) RimBridgeUiWorkbench.PrepareControlInteraction(state, rect);
        return state;
    }
    public static void End(RimBridgeUiWorkbench.UiPatchControlState state, ref string result, int maxLength = -1) {
        if (RimBridgeUiWorkbench.TryGetFormInput(state, out var text) && !Mouse.IsInputBlockedNow) {
            result = maxLength < 0 ? text ?? "" : (text ?? "").Substring(0, Math.Min(maxLength, (text ?? "").Length));
            RimBridgeUiWorkbench.ObserveControlResult(state, true, "Text supplied through the GUI field; caller validation follows.");
        }
        else if (GUIUtility.keyboardControl != 0 && Event.current.type == EventType.Used && RimBridgeUiWorkbench.IsReleasingControl(state) && !Mouse.IsInputBlockedNow) {
            RimBridgeUiWorkbench.ObserveControlResult(state, true, "Original GUI text field consumed the focus input.");
        }
        RimBridgeUiWorkbench.EndCompoundControl(state);
    }
}

[HarmonyPatch]
internal static class RpStyledTextFieldPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(GUI).GetMethods().Where(m => m.Name == "TextField" && m.GetParameters().Any(p => p.ParameterType == typeof(GUIStyle)));
    private static void Prefix(Rect position, string text, out RimBridgeUiWorkbench.UiPatchControlState __state) => __state = RpFormAdapter.Begin(position, text);
    private static void Postfix(ref string __result, MethodBase __originalMethod, object[] __args, RimBridgeUiWorkbench.UiPatchControlState __state) {
        var maximum = -1; var parameters = __originalMethod.GetParameters();
        for (var i = 0; i < parameters.Length; i++) if (parameters[i].Name == "maxLength") maximum = (int)__args[i];
        RpFormAdapter.End(__state, ref __result, maximum);
    }
}

[HarmonyPatch(typeof(GUI), "HandleTextFieldEventForDesktop")]
internal static class RpDesktopTextFieldInputPatch
{
    private static void Prefix(int id, out Event __state) => __state = RpKeyboard.BeginTextField(id);
    private static void Postfix(Event __state) => RpKeyboard.EndTextField(__state);
    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
        var getter = AccessTools.PropertyGetter(typeof(Event), nameof(Event.type));
        foreach (var instruction in instructions) {
            if (instruction.Calls(getter)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.EventTypeForActiveControl)); }
            yield return instruction;
        }
    }
}

[HarmonyPatch]
internal static class RpSliderPatch
{
    internal sealed class State { public float Before; public RimBridgeUiWorkbench.UiPatchControlState Control; }
    private static MethodBase TargetMethod() => typeof(Widgets).GetMethods().Single(m => m.Name == "HorizontalSlider" && m.ReturnType == typeof(float));
    private static void Prefix(Rect rect, float value, float min, float max, bool middleAlignment, string label, out State __state) {
        __state = new State { Before = value, Control = RimBridgeUiWorkbench.BeginCompoundControl("slider", "rp.slider", rect, label, value.ToString(CultureInfo.InvariantCulture)) };
        Vector2? pointer = null;
        if (RimBridgeUiWorkbench.TryGetFormInput(__state.Control, out var text)) {
            if (!float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var target)) throw new RpException("INVALID_ARGUMENT", "Slider value must be a number.");
            var y = rect.y;
            if (middleAlignment || !string.IsNullOrEmpty(label)) y += Mathf.Round((rect.height - 10) / 2);
            if (!string.IsNullOrEmpty(label)) y += 5;
            pointer = new Vector2(rect.x + 6 + (rect.width - 12) * Mathf.InverseLerp(min, max, target), y + 5);
        }
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect, pointer);
    }
    private static void Postfix(float __result, State __state) {
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control, Math.Abs(__result - __state.Before) > 0.00001f || RimBridgeUiWorkbench.MouseDragForActiveControl(), "Value handled by original visible slider.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control);
    }
    private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
        var type = AccessTools.PropertyGetter(typeof(Event), nameof(Event.type));
        var drag = AccessTools.Method(typeof(UnityGUIBugsFixer), nameof(UnityGUIBugsFixer.MouseDrag));
        foreach (var instruction in instructions) {
            if (instruction.Calls(type)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.EventTypeForActiveControl)); }
            if (instruction.Calls(drag)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RimBridgeUiWorkbench), nameof(RimBridgeUiWorkbench.MouseDragForActiveControl)); }
            yield return instruction;
        }
    }
}
