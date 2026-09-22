using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using RimUIMCP.Sdk;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal static partial class RpUi
{
    public static async Task<object> InvokeAsync(string method, JObject args, CancellationToken ct)
    {
        if (method == "ui.snapshot") return await Snapshot(args, ct);
        if (method == "ui.resolve" || method == "ui.read") return await Resolve(args, false, ct);
        if (method == "ui.screenshot") {
            // Unity writes asynchronously. A unique destination prevents an old file
            // with the same requested name from satisfying upstream's exists check.
            var requestedName = RpArgs.String(args, "name");
            var captureName = (string.IsNullOrWhiteSpace(requestedName) ? "rimplay" : requestedName) + "-" + Guid.NewGuid().ToString("N");
            var capture = JObject.FromObject(Checked(await Task.Run(() => new RimBridgeTools().TakeScreenshot(captureName, true, true), ct)));
            var path = capture.Value<string>("path");
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (!CompletePng(path)) {
                if (DateTime.UtcNow >= deadline) throw new RpException("SCREENSHOT_INCOMPLETE", "The screenshot file did not finish writing.", new { path });
                await Task.Delay(10, ct);
            }
            capture["requestedFileName"] = requestedName;
            capture["sizeBytes"] = new FileInfo(path).Length;
            return capture;
        }
        if (method == "ui.panel") {
            await RimBridgeMainThread.InvokeAsync(() => {
                if (Current.ProgramState != ProgramState.Playing) throw new RpException("GAME_NOT_READY", "Colony panels are available after entering a game; use main.entry controls on the title screen.");
                return true;
            }, ct);
            var name = RpArgs.String(args, "name") ?? throw new RpException("INVALID_ARGUMENT", "Panel name is required.");
            bool IsOpen() => name.Equals("world", StringComparison.OrdinalIgnoreCase) ? WorldRendererUtility.WorldSelected
                : string.Equals(Find.MainTabsRoot.OpenTab?.defName, name, StringComparison.OrdinalIgnoreCase);
            var open = await RimBridgeMainThread.InvokeAsync(IsOpen, ct);
            if (open) return new { path = "ui-control", inputProcessed = false, commandAccepted = true, completion = "succeeded", unchanged = true };
            var actionResult = await InvokeAsync("ui.input", new JObject { ["selector"] = new JObject { ["actionId"] = "panel." + name.ToLowerInvariant() }, ["action"] = "click" }, ct);
            if (!await RimBridgeMainThread.InvokeAsync(IsOpen, ct))
                throw new RpException("RESULT_NOT_OBSERVED", "Panel input processed but requested panel is not open.", actionResult);
            return actionResult;
        }
        if (method == "ui.reveal" || method == "ui.select") return await RpMapInput.SelectOrReveal(method, args, ct);
        if (method.StartsWith("map.")) return await RpMapInput.Input(method, args, ct);
        if (method.StartsWith("world.")) return await RpWorldInput.Input(method, args, ct);
        if (method != "ui.input") throw new RpException("UNKNOWN_METHOD", method);
        var action = RpArgs.String(args, "action", "click");
        if (action == "press") {
            if (args["selector"] != null || args["targetId"] != null) {
                var keyTarget = await Resolve(args, true, ct);
                if (keyTarget.Value<string>("role") != "text_field") throw new RpException("UNSUPPORTED_INPUT", "Locator.press focuses text fields; use ui.press for a global shortcut.");
                var focus = (JObject)args.DeepClone(); focus["action"] = "click"; focus.Remove("modifiers");
                await InvokeAsync("ui.input", focus, ct);
            }
            return await RpKeyboard.Press(RpArgs.String(args, "key", "Escape"), RpArgs.String(args, "modifiers"), ct);
        }
        var node = await Resolve(args, action != "hover" && action != "scroll", ct);
        if (node.Value<string>("surface") == "main.letters" && args["selector"] != null && int.TryParse(node.Value<string>("rowKey"), out var letterId)) {
            await RpLetterInput.WaitForStableIcon(letterId, ct);
            node = await Resolve(args, action != "hover", ct);
        }
        if (node.Value<bool?>("disabled") == true) throw new RpException("CONTROL_DISABLED", "Control is disabled.", node);
        await RimBridgeMainThread.InvokeAsync(() => {
            var surface = node.Value<string>("surface");
            var window = Find.WindowStack.Windows.FirstOrDefault(w => surface == "window:" + w.ID + ":" + w.GetType().FullName || surface == "window-extra:" + w.ID + ":" + w.GetType().FullName ||
                (surface.StartsWith("main-tab:") && w is MainTabWindow && w.GetType().FullName == node.Value<string>("surfaceType")));
            if (!Find.WindowStack.GetsInput(window)) throw new RpException("UI_BLOCKED", "A modal window blocks this control; resolve the foreground dialog first.");
            if (node.Value<string>("role") == "text_field" && window != null && (action == "click" || action == "activate"))
                Find.WindowStack.Notify_ManuallySetFocus(window);
            return true;
        }, ct);
        if (action == "setChecked") {
            if (node["isChecked"]?.Type == JTokenType.Null) throw new RpException("INVALID_ARGUMENT", "Target does not expose a checkbox value.");
            if (node.Value<bool>("isChecked") == args.Value<bool>("value")) return new { path = "ui-control", inputProcessed = false, commandAccepted = true, completion = "succeeded", unchanged = true };
            action = "click";
        }
        var target = node.Value<string>("targetId");
        var timeout = RpArgs.Int(args, "timeoutMs", 2000);
        object response;
        using (ct.Register(RimBridgeUiWorkbench.CancelPendingInput)) {
            switch (action) {
                case "activate": case "click": case "fill": case "setValue":
                    if ((action == "fill" || action == "setValue") && node.Value<string>("role") != "text_field" && node.Value<string>("role") != "slider") throw new RpException("UNSUPPORTED_INPUT", "fill/setValue needs a text field, numeric field or slider.");
                    var text = args["text"]?.ToString() ?? args["value"]?.ToString();
                    if (node.Value<string>("role") == "slider" && (action == "fill" || action == "setValue") &&
                        (!float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var numeric) || float.IsNaN(numeric) || float.IsInfinity(numeric)))
                        throw new RpException("INVALID_ARGUMENT", "Slider value must be a finite number.");
                    var button = RpArgs.String(args, "button", "left") switch { "left" => 0, "right" => 1, "middle" => 2, _ => throw new RpException("INVALID_ARGUMENT", "Use left, right or middle button.") };
                    var modifiers = RpMapInput.Modifiers(RpArgs.String(args, "modifiers"));
                    response = await Task.Run(() => RimBridgeUiWorkbench.ClickUiTargetResponse(target, timeout, button, action, text, modifiers), ct);
                    break;
                case "scroll":
                    response = await Task.Run(() => RimBridgeUiWorkbench.ScrollUiTargetResponse(target, args.Value<float?>("deltaY") ?? 0, args.Value<float?>("deltaX") ?? 0, args.Value<float?>("targetY"), args.Value<float?>("targetX"), timeout), ct);
                    break;
                case "hover":
                    response = await Task.Run(() => RimBridgeUiWorkbench.SetHoverTargetResponse(target, durationMs: 5000, settleMs: 0), ct);
                    break;
                default: throw new RpException("UNSUPPORTED_INPUT", "Unsupported input: " + action);
            }
        }
        var evidence = Checked(response);
        if (node.Value<string>("role") == "text_field" && (action == "click" || action == "activate"))
            await RimBridgeMainThread.InvokeAsync(() => { RpKeyboard.RememberTextFocus(); return true; }, ct);
        else if (action == "click" || action == "activate") RpKeyboard.ClearTextFocus();
        await RimBridge.Game.NextFrameAsync(ct);
        return new { target = node, path = "ui-control", inputProcessed = true, commandAccepted = (bool?)null, completion = "not-checked", evidence };
    }
    private static bool CompletePng(string path) {
        try {
            using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length < 20) return false;
            var header = new byte[8]; var footer = new byte[12];
            if (stream.Read(header, 0, header.Length) != header.Length) return false;
            stream.Seek(-footer.Length, SeekOrigin.End);
            return stream.Read(footer, 0, footer.Length) == footer.Length &&
                header.SequenceEqual(new byte[] {137,80,78,71,13,10,26,10}) &&
                footer.SequenceEqual(new byte[] {0,0,0,0,73,69,78,68,174,66,96,130});
        } catch (IOException) { return false; }
    }
}
