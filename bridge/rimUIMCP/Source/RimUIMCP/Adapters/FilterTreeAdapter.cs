using HarmonyLib;
using UnityEngine;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(Listing_TreeThingFilter), "DoThingDef")]
internal static class RpFilterThingScopePatch
{
    private static void Prefix(ThingDef tDef, ThingFilter ___filter, out RpUiContext __state) => __state = new RpUiContext(
        "filter.thing." + tDef.defName, RpSession.Reference(___filter).id, tDef.defName, tDef.LabelCap.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(Listing_TreeThingFilter), "DoCategory")]
internal static class RpFilterCategoryScopePatch
{
    private static void Prefix(TreeNode_ThingCategory node, ThingFilter ___filter, out RpUiContext __state) => __state = new RpUiContext(
        "filter.category." + node.catDef.defName, RpSession.Reference(___filter).id, node.catDef.defName, node.LabelCap.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(Listing_TreeThingFilter), "DoSpecialFilter")]
internal static class RpFilterSpecialScopePatch
{
    private static void Prefix(SpecialThingFilterDef sfDef, ThingFilter ___filter, out RpUiContext __state) => __state = new RpUiContext(
        "filter.special." + sfDef.defName, RpSession.Reference(___filter).id, sfDef.defName, sfDef.LabelCap.ToString());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(Widgets), nameof(Widgets.CheckboxMulti))]
internal static class RpMultiCheckboxPatch
{
    internal sealed class State { public MultiCheckboxState Before; public RimBridgeUiWorkbench.UiPatchControlState Control; }
    private static void Prefix(Rect rect, MultiCheckboxState state, out State __state) {
        __state = new State { Before = state, Control = RimBridgeUiWorkbench.BeginCompoundControl("checkbox", "widgets.checkbox_multi", rect,
            valueText: state.ToString(), checkedState: state == MultiCheckboxState.Partial ? (bool?)null : state == MultiCheckboxState.On, disabled: !GUI.enabled) };
        RimBridgeUiWorkbench.PrepareControlInteraction(__state.Control, rect);
    }
    private static void Postfix(MultiCheckboxState __result, State __state) {
        RimBridgeUiWorkbench.ObserveControlResult(__state.Control, __result != __state.Before, "Category checkbox handled by original widget.");
        RimBridgeUiWorkbench.EndCompoundControl(__state.Control);
    }
}
