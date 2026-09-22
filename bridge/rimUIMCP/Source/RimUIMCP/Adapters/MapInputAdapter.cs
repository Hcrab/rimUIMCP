using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using RimUIMCP.Sdk;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal static class RpMapInput
{
    internal static void Available() {
        if (Current.ProgramState != ProgramState.Playing || Find.CurrentMap == null || LongEventHandler.AnyEventNowOrWaiting)
            throw new RpException("GAME_NOT_READY", "Map is loading or unavailable.");
        if (Find.WindowStack.Windows.Any(w => w is not ImmediateWindow && w.forcePause && w is not RimWorld.MainTabWindow))
            throw new RpException("UI_BLOCKED", "Close the blocking dialog before map input.");
    }
    public static async Task<object> SelectOrReveal(string method, JObject args, CancellationToken ct) {
        if (method == "ui.select") {
            for (var i = 0; i < 4; i++) {
                var active = await RimBridgeMainThread.InvokeAsync(() => { Available(); return Find.DesignatorManager.SelectedDesignator != null; }, ct);
                if (!active) break;
                await RpKeyboard.Press("Escape", null, ct);
                await RimBridge.Game.NextFrameAsync(ct);
            }
            if (await RimBridgeMainThread.InvokeAsync(() => Find.DesignatorManager.SelectedDesignator != null, ct)) throw new RpException("UI_BLOCKED", "Cancel the active designator before selecting an object.");
        }
        var position = await RimBridgeMainThread.InvokeAsync(() => {
            Available();
            var id = RpArgs.String(args, "pawnId") ?? RpArgs.String(args, "thingId");
            var thing = id != null ? RpStateReader.Thing(id) : null;
            var cell = thing?.Position ?? new IntVec3(RpArgs.Int(args, "x"), 0, RpArgs.Int(args, "z"));
            if (thing != null && thing.Map != Find.CurrentMap) throw new RpException("WRONG_MAP", "Select the target's map before revealing this thing.");
            if (!cell.InBounds(Find.CurrentMap)) throw new RpException("INVALID_ARGUMENT", "Cell is outside the current map.");
            Find.CameraDriver.JumpToCurrentMapLoc(cell);
            return cell;
        }, ct);
        // The camera transform and the UI projection settle on successive frames.
        await RimBridge.Game.FramesAsync(2, ct);
        if (method == "ui.reveal") return new { path = "ui-control", inputProcessed = true, commandAccepted = true, completion = "succeeded", evidence = "CameraDriver.JumpToCurrentMapLoc", x = position.x, z = position.z };
        var expected = RpArgs.String(args, "pawnId") ?? RpArgs.String(args, "thingId");
        var result = await Input("map.click", new JObject { ["x"] = position.x, ["z"] = position.z, ["button"] = "left", ["drawnThingId"] = expected }, ct);
        if (expected != null && !await RimBridgeMainThread.InvokeAsync(() => Find.Selector.SelectedObjects.OfType<Thing>().Any(t => t.ThingID == expected), ct))
            throw new RpException("RESULT_NOT_OBSERVED", "Map click processed but target is not selected; another object may share the cell.", result);
        return result;
    }
    public static async Task<object> Input(string method, JObject args, CancellationToken ct) {
        await RimBridgeMainThread.InvokeAsync(() => { Available(); return true; }, ct);
        var start = new IntVec3(RpArgs.Int(args, "x"), 0, RpArgs.Int(args, "z"));
        var end = new IntVec3(RpArgs.Int(args, "endX"), 0, RpArgs.Int(args, "endZ"));
        await RimBridgeMainThread.InvokeAsync(() => {
            if (!start.InBounds(Find.CurrentMap) || (method == "map.drag" && !end.InBounds(Find.CurrentMap))) throw new RpException("INVALID_ARGUMENT", "Map input is out of bounds.");
            return true;
        }, ct);
        var button = RpArgs.String(args, "button", "left");
        var options = new MapClickDispatchOptions { Button = button == "right" ? 1 : button == "middle" ? 2 : 0, ButtonName = button,
            Modifiers = Modifiers(RpArgs.String(args, "modifiers")), HoldDurationMs = RpArgs.Int(args, "holdMs", 0) };
        var drawnId = RpArgs.String(args, "drawnThingId");
        if (drawnId != null) options.ScreenPositionInverted = await RimBridgeMainThread.InvokeAsync(() => RpStateReader.Thing(drawnId).DrawPos.MapToUIPosition(), ct);
        MapClickDispatchResult result;
        using (ct.Register(() => { _ = RimBridgeMainThread.InvokeAsync(() => { RimBridgeMapClickInjector.CancelPendingRequest(); return true; }); })) {
            result = await Task.Run(() => method == "map.drag" ? RimBridgeMapClickInjector.DispatchDrag(start, end, "rimUIMCP map drag", options)
                : RimBridgeMapClickInjector.DispatchClick(start, "rimUIMCP map click", options), ct);
        }
        if (!result.Success) throw new RpException("UI_ACTION_FAILED", result.Message);
        await RimBridge.Game.NextFrameAsync(ct);
        return new { path = "ui-input", inputProcessed = true, commandAccepted = (bool?)null, completion = "not-checked", evidence = new { result.Message, result.GestureKind } };
    }
    internal static EventModifiers Modifiers(string text) {
        var value = EventModifiers.None;
        foreach (var part in (text ?? "").ToLowerInvariant().Split(new[] { '+', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            value |= part switch { "ctrl" => EventModifiers.Control, "shift" => EventModifiers.Shift, "alt" => EventModifiers.Alt, "command" => EventModifiers.Command, _ => throw new RpException("INVALID_ARGUMENT", "Unknown modifier " + part) };
        return value;
    }
}

internal static class RpKeyboard
{
    internal sealed class Request { public Event Key; public bool TextHandled, TextOnly; public TaskCompletionSource<bool> Done = new(TaskCreationOptions.RunContinuationsAsynchronously); }
    private static Request pending;
    private static string textFocusContext;
    internal static void RememberTextFocus() => textFocusContext = RpUi.Context();
    internal static void ClearTextFocus() => textFocusContext = null;
    public static async Task<object> Press(string key, string modifiers, CancellationToken ct) {
        var request = await RimBridgeMainThread.InvokeAsync(() => {
            if (pending != null) throw new RpException("UI_BUSY", "Another key is pending.");
            if (!Enum.TryParse<KeyCode>(key, true, out var code)) throw new RpException("INVALID_ARGUMENT", "Use a Unity KeyCode name, such as Escape, Return, Q or E.");
            var eventName = code switch { KeyCode.LeftArrow => "left", KeyCode.RightArrow => "right", KeyCode.UpArrow => "up", KeyCode.DownArrow => "down", KeyCode.PageUp => "page up", KeyCode.PageDown => "page down", KeyCode.KeypadEnter => "[enter]", _ => code.ToString().ToLowerInvariant() };
            var input = Event.KeyboardEvent(eventName); // Unity supplies FunctionKey flags needed by TextEditor key bindings.
            input.modifiers |= RpMapInput.Modifiers(modifiers);
            if (input.control || input.alt || input.command) input.character = '\0';
            else if (input.shift) input.character = char.ToUpperInvariant(input.character);
            return pending = new Request { TextOnly = textFocusContext == RpUi.Context() && code != KeyCode.Escape && code != KeyCode.Return && code != KeyCode.KeypadEnter && code != KeyCode.Tab, Key = input };
        }, ct);
        try {
            using (ct.Register(() => request.Done.TrySetCanceled())) {
                var processed = await request.Done.Task;
                return new { path = "ui-input", inputProcessed = processed, commandAccepted = (bool?)null, completion = "not-checked", key };
            }
        } finally { await RimBridgeMainThread.InvokeAsync(() => { if (pending == request) pending = null; return true; }); }
    }
    internal static Event Begin() { if (pending == null || pending.TextOnly) return null; var old = Event.current; Event.current = new Event(pending.Key); return old; }
    // GUI.Window runs its callback in a separate IMGUI event context. Deliver a key
    // there only when Unity says this real text control owns keyboard focus.
    internal static Event BeginTextField(int id) {
        if (pending == null || pending.TextHandled || GUIUtility.keyboardControl != id || Mouse.IsInputBlockedNow || !GUI.enabled) return null;
        var old = Event.current; Event.current = new Event(pending.Key); return old;
    }
    internal static void EndTextField(Event old) {
        if (old == null) return;
        var request = pending;
        if (request != null && Event.current.type == EventType.Used) request.TextHandled = true;
        Event.current = old;
        if (request?.TextOnly == true) { pending = null; request.Done.TrySetResult(request.TextHandled); }
    }
    internal static void End(Event old) { if (old == null) return; var used = Event.current.type == EventType.Used || pending?.TextHandled == true; Event.current = old; var request = pending; pending = null; request?.Done.TrySetResult(used); }
}
[HarmonyPatch(typeof(UIRoot_Play), nameof(UIRoot_Play.UIRootOnGUI))]
internal static class RpKeyPatch
{
    private static void Prefix(out Event __state) => __state = RpKeyboard.Begin();
    private static void Postfix(Event __state) => RpKeyboard.End(__state);
}

[HarmonyPatch(typeof(UIRoot_Entry), nameof(UIRoot_Entry.UIRootOnGUI))]
internal static class RpEntryKeyPatch
{
    private static void Prefix(out Event __state) => __state = RpKeyboard.Begin();
    private static void Postfix(Event __state) => RpKeyboard.End(__state);
}
