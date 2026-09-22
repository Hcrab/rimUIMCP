using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using RimWorld;
using Verse;

namespace RimUIMCP;

[HarmonyPatch(typeof(MainTabWindow_Research), "GetLabel")]
internal static class RpResearchProjectDrawPatch
{
    [ThreadStatic] internal static ResearchProjectDef CurrentProject;
    private static void Prefix(ResearchProjectDef r) => CurrentProject = r;
}

[HarmonyPatch]
internal static class RpResearchButtonScopePatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(Widgets).GetMethods().Where(m => m.Name == "CustomButtonText");
    private static void Prefix(out RpUiContext __state) {
        var project = RpResearchProjectDrawPatch.CurrentProject;
        __state = Find.MainTabsRoot?.OpenTab == MainButtonDefOf.Research && project != null
            ? new RpUiContext("research.project." + project.defName, rowKey: project.defName, name: project.LabelCap.ToString()) : null;
    }
    private static void Postfix(RpUiContext __state) => __state?.Dispose();
}

[HarmonyPatch(typeof(MainTabWindow_Research), "DrawStartButton")]
internal static class RpResearchStartScopePatch
{
    private static void Prefix(MainTabWindow_Research __instance, out RpUiContext __state) {
        var project = __instance.selectedProject;
        __state = new RpUiContext(Find.ResearchManager.IsCurrentProject(project) ? "research.stop" : "research.start", rowKey: project.defName);
    }
    private static void Postfix(RpUiContext __state) => __state.Dispose();
}
