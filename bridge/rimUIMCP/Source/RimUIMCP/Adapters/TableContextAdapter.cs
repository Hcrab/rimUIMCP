using System;
using System.Collections.Generic;
using HarmonyLib;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal sealed class RpUiContext : IDisposable
{
    [ThreadStatic] private static Stack<RpUiContext> contexts;
    public static RpUiContext Current => contexts?.Count > 0 ? contexts.Peek() : null;
    public string ActionId, OwnerId, RowKey;
    public string Name;
    public RpUiContext(string actionId = null, string ownerId = null, string rowKey = null, string name = null) {
        ActionId = actionId ?? Current?.ActionId; OwnerId = ownerId ?? Current?.OwnerId; RowKey = rowKey ?? Current?.RowKey;
        Name = name ?? Current?.Name;
        (contexts ??= new()).Push(this);
    }
    public void Dispose() { if (contexts?.Count > 0 && ReferenceEquals(contexts.Peek(), this)) contexts.Pop(); }
}

[HarmonyPatch(typeof(MainButtonsRoot), nameof(MainButtonsRoot.MainButtonsOnGUI))]
internal static class RpMainButtonsSurfacePatch
{
    private static void Prefix() => RimBridgeUiWorkbench.BeginCustomSurface("main.buttons", typeof(MainButtonsRoot).FullName);
    private static void Postfix() => RimBridgeUiWorkbench.EndSurface();
}

[HarmonyPatch(typeof(MainMenuDrawer), nameof(MainMenuDrawer.DoMainMenuControls))]
internal static class RpEntrySurfacePatch
{
    private static void Prefix(out bool __state) {
        __state = Current.ProgramState != ProgramState.Playing;
        if (__state) RimBridgeUiWorkbench.BeginCustomSurface("main.entry", typeof(MainMenuDrawer).FullName);
    }
    private static void Postfix(bool __state) { if (__state) RimBridgeUiWorkbench.EndSurface(); }
}

[HarmonyPatch(typeof(MainButtonWorker), nameof(MainButtonWorker.DoButton))]
internal static class RpMainButtonPatch
{
    internal sealed class State { public RpUiContext Scope; public RimBridgeUiWorkbench.UiPatchControlState Control; public string Before; }
    private static void Prefix(MainButtonWorker __instance, Rect rect, out State __state) {
        __state = new State { Scope = new RpUiContext("panel." + __instance.def.defName.ToLowerInvariant()), Before = RpUi.Context() };
        __state.Control = RimBridgeUiWorkbench.BeginCompoundControl("button", "rp.main_button", rect, __instance.def.LabelCap.ToString(), disabled: __instance.Disabled);
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect);
    }
    private static void Postfix(State __state) {
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control, __state.Before != RpUi.Context(), "Main UI changed through original button.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control); __state.Scope.Dispose();
    }
}

[HarmonyPatch(typeof(Command), nameof(Command.GizmoOnGUI))]
internal static class RpCommandScopePatch
{
    private static void Prefix(Command __instance, out RpUiContext __state) {
        string action = __instance.hotKey?.defName;
        if (action == "Command_ColonistDraft") action = "draft";
        else if (action != null) action = "command." + action;
        if (action == null && __instance.tutorTag != "TutorTagNotSet") action = __instance.tutorTag;
        if (__instance is Designator_Build build) action = "build." + build.PlacingDef.defName;
        else if (__instance is Designator designator) action = "designator." + designator.GetType().Name;
        __state = new RpUiContext(action, Current.ProgramState == ProgramState.Playing ? Find.Selector.SingleSelectedThing?.ThingID : null, name: __instance.LabelCap);
    }
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(MainTabWindow_Architect), "DoCategoryButton")]
internal static class RpArchitectCategoryScopePatch
{
    private static void Prefix(ArchitectCategoryTab panel, out RpUiContext __state) => __state = new RpUiContext("architect.category." + panel.def.defName, name: panel.def.LabelCap.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(TimeAssignmentSelector), "DrawTimeAssignmentSelectorFor")]
internal static class RpScheduleSelectorPatch
{
    private static void Prefix(TimeAssignmentDef ta, out RpUiContext __state) => __state = new RpUiContext("schedule.assignment." + ta.defName, name: ta.LabelCap.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}
