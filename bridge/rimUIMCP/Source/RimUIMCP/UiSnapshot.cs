using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using RimWorld;
using RimWorld.Planet;
using Verse;

namespace RimUIMCP;

internal static partial class RpUi
{
    private sealed class Capture { public int Epoch; public string Context; public JObject Node; }
    private static readonly Dictionary<string, Capture> Captures = new();
    private static readonly Queue<string[]> CaptureGroups = new();
    internal static string Context() {
        var windows = string.Join(",", Find.WindowStack?.Windows.Where(w => w is not ImmediateWindow).Select(RuntimeHelpers.GetHashCode) ?? new int[0]);
        if (Current.ProgramState != ProgramState.Playing) return RpSession.WorldEpoch + "|entry|" + windows;
        return RpSession.WorldEpoch + "|" + Find.CurrentMap?.uniqueID + "|" + Find.MainTabsRoot?.OpenTab?.defName + "|"
            + string.Join(",", Find.Selector?.SelectedObjects.Select(RuntimeHelpers.GetHashCode) ?? new int[0]) + "|" + windows
            + "|world:" + WorldRendererUtility.WorldSelected + ":" + Find.WorldSelector?.SelectedTile
            + ":" + string.Join(",", Find.WorldSelector?.SelectedObjects.Select(o => o.ID) ?? new int[0]);
    }
    internal static JObject Checked(object response) {
        var result = JObject.FromObject(response);
        if (result.Value<bool?>("success") == false) {
            var message = result.Value<string>("message") ?? "Original UI operation failed.";
            var code = message.IndexOf("disabled", StringComparison.OrdinalIgnoreCase) >= 0 ? "CONTROL_DISABLED" :
                message.IndexOf("Timed out", StringComparison.OrdinalIgnoreCase) >= 0 ? "UI_TIMEOUT" : "UI_ACTION_FAILED";
            throw new RpException(code, message, result);
        }
        return result;
    }
    private static string SurfaceAlias(string surface) {
        if (surface == null || !surface.StartsWith("main.") || surface == "main.buttons") return surface;
        var name = surface.Substring(5);
        var def = DefDatabase<MainButtonDef>.AllDefsListForReading.FirstOrDefault(d => d.defName.Equals(name, StringComparison.OrdinalIgnoreCase));
        return def == null ? surface : "main-tab:" + def.defName;
    }
    internal static async Task<JObject> Snapshot(JObject args, CancellationToken ct) {
        ct.ThrowIfCancellationRequested();
        var before = await RimBridgeMainThread.InvokeAsync(() => {
            if (LongEventHandler.AnyEventNowOrWaiting) throw new RpException("GAME_LOADING", "The game is loading or generating a world; inspect session.status.loading before asking for UI controls.");
            RpSession.RefreshWorld(); return Context();
        }, ct);
        var surface = await RimBridgeMainThread.InvokeAsync(() => SurfaceAlias(RpArgs.String(args, "surface")), ct);
        var raw = Checked(await Task.Run(() => RimBridgeUiWorkbench.GetUiLayoutResponse(surface, RpArgs.Int(args, "timeoutMs", 2000)), ct));
        return await RimBridgeMainThread.InvokeAsync(() => {
            if (before != Context()) throw new RpException("STALE_UI_REFERENCE", "UI context changed during capture; request a new snapshot.");
            var nodes = new JArray();
            foreach (var pane in raw["surfaces"]!.Children<JObject>()) {
                foreach (var element in pane["elements"]!.Children<JObject>()) {
                    // Wrapper and underlying GUI functions can describe the same text box.
                    if (element.Value<string>("kind") == "text_field" && element.Value<bool?>("actionable") != true &&
                        pane["elements"].Children<JObject>().Any(other => other.Value<string>("kind") == "text_field" && other.Value<bool?>("actionable") == true && JToken.DeepEquals(other["screenRect"], element["screenRect"]))) continue;
                    var node = (JObject)element.DeepClone();
                    node["role"] = node["kind"]; node["name"] = node["semanticName"]?.Type == JTokenType.String ? node["semanticName"] : node["label"];
                    if (node.Value<bool?>("actionable") == true && string.IsNullOrEmpty(node.Value<string>("name"))) {
                        var box = node["screenRect"];
                        var names = pane["elements"].Children<JObject>().Where(n => n.Value<string>("kind") == "label" && !string.IsNullOrEmpty(n.Value<string>("label")))
                            .Where(n => { var b = n["screenRect"]; var x = b.Value<float>("x") + b.Value<float>("width") / 2; var y = b.Value<float>("y") + b.Value<float>("height") / 2;
                                return x >= box.Value<float>("x") && x <= box.Value<float>("x") + box.Value<float>("width") && y >= box.Value<float>("y") && y <= box.Value<float>("y") + box.Value<float>("height"); })
                            .Select(n => n.Value<string>("label")).Distinct().ToArray();
                        if (names.Length == 1) { node["name"] = names[0]; node["nameSource"] = "contained-label"; }
                    }
                    node["surface"] = pane["surfaceTargetId"]; node["surfaceType"] = pane["type"];
                    node["worldEpoch"] = RpSession.WorldEpoch; node["sessionId"] = RpSession.SessionId;
                    node["visible"] = node["screenRect"]!.Value<float>("width") > 0 && node["screenRect"]!.Value<float>("height") > 0;
                    var id = node.Value<string>("targetId");
                    Captures[id] = new Capture { Epoch = RpSession.WorldEpoch, Context = before, Node = node };
                    nodes.Add(node);
                }
            }
            CaptureGroups.Enqueue(nodes.Select(n => n.Value<string>("targetId")).ToArray());
            while (CaptureGroups.Count > 8) foreach (var id in CaptureGroups.Dequeue()) Captures.Remove(id);
            return new JObject { ["captureId"] = raw["captureId"], ["capturedFrame"] = raw["capturedFrame"], ["nodes"] = nodes, ["surfaces"] = raw["surfaces"] };
        }, ct);
    }
    private static IEnumerable<JObject> Match(JObject snapshot, JObject selector) {
        IEnumerable<JObject> nodes = snapshot["nodes"]!.Children<JObject>();
        var exact = RpArgs.Bool(selector, "exact", true);
        foreach (var key in new[] { "surface", "role", "name", "actionId", "ownerId", "rowKey", "parentTargetId", "source" }) {
            if (selector[key] == null) continue;
            var expected = selector.Value<string>(key);
            if (key == "surface") expected = SurfaceAlias(expected);
            nodes = nodes.Where(n => key == "name" && !exact ? (n.Value<string>(key) ?? "").IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0 : n.Value<string>(key) == expected);
        }
        if (selector["ownerRef"] != null) {
            var owner = RpSession.Resolve(selector["ownerRef"]);
            var ownerId = owner is Thing thing ? thing.ThingID : RpSession.Reference(owner).id;
            nodes = nodes.Where(n => n.Value<string>("ownerId") == ownerId);
        }
        return nodes;
    }
    internal static async Task<JObject> Resolve(JObject args, bool actionable, CancellationToken ct) {
        var targetId = RpArgs.String(args, "targetId");
        if (targetId != null) return await RimBridgeMainThread.InvokeAsync(() => {
            if (!Captures.TryGetValue(targetId, out var capture) || capture.Epoch != RpSession.WorldEpoch || capture.Context != Context())
                throw new RpException("STALE_UI_REFERENCE", "UI reference expired; resolve the locator again.");
            if (actionable && capture.Node.Value<bool?>("actionable") != true) throw new RpException("CONTROL_NOT_ACTIONABLE", "Choose an actionable control.");
            return capture.Node;
        }, ct);
        var selector = args["selector"] as JObject ?? new JObject();
        var snapshot = await Snapshot(new JObject { ["timeoutMs"] = args["timeoutMs"] ?? 2000 }, ct);
        return await RimBridgeMainThread.InvokeAsync(() => {
            var matches = Match(snapshot, selector).Where(n => !actionable || n.Value<bool?>("actionable") == true).ToArray();
            if (selector["nth"] != null) matches = matches.Skip(RpArgs.Int(selector, "nth")).Take(1).ToArray();
            if (matches.Length == 0) throw new RpException("TARGET_NOT_FOUND", "No visible control matches the selector.", selector);
            if (matches.Length > 1) throw new RpException("AMBIGUOUS_TARGET", "Selector matches multiple controls. Add ownerId/rowKey/parent or an explicit nth.", new { count = matches.Length, matches });
            return matches[0];
        }, ct);
    }
}
