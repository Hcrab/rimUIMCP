using HarmonyLib;
using RimWorld;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(Bill), nameof(Bill.DoInterface))]
internal static class RpBillRowScopePatch
{
    private static void Prefix(Bill __instance, out RpUiContext __state) => __state = new RpUiContext(ownerId: (__instance.billStack?.billGiver as Thing)?.ThingID, rowKey: __instance.GetUniqueLoadID());
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}

[HarmonyPatch(typeof(TradeUI), nameof(TradeUI.DrawTradeableRow))]
internal static class RpTradeRowScopePatch
{
    private static void Prefix(Tradeable trad, out RpUiContext __state) => __state = new RpUiContext(ownerId: RpSession.Reference(trad).id,
        rowKey: trad.ThingDef?.defName ?? "currency");
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}
