using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using RimUIMCP.Sdk;
using Verse;

namespace RimUIMCP;

internal static class RpRuntime
{
    public static async Task<object> Invoke(string method, JObject args, CancellationToken ct) {
        switch (method) {
            case "runtime.pause": case "runtime.speed":
                return await RimBridgeMainThread.InvokeAsync(() => {
                    if (Current.Game == null) throw new RpException("GAME_NOT_READY", "Load a game first.");
                    var speed = method == "runtime.pause" ? (RpArgs.Bool(args, "paused", true) ? TimeSpeed.Paused : TimeSpeed.Normal)
                        : (TimeSpeed)RpArgs.Int(args, "speed", 1);
                    if ((int)speed < 0 || (int)speed > 4) throw new RpException("INVALID_ARGUMENT", "Speed must be 0..4.");
                    Find.TickManager.CurTimeSpeed = speed;
                    return (object)new { path = "runtime", requestedSpeed = speed.ToString(), actualSpeed = Find.TickManager.CurTimeSpeed.ToString(), gameTick = Find.TickManager.TicksGame };
                }, ct);
            case "runtime.nextFrame":
                var frames = RpArgs.Int(args, "frames", 1);
                if (frames < 1 || frames > 10000) throw new RpException("INVALID_ARGUMENT", "frames must be 1..10000.");
                await RimBridge.Game.FramesAsync(frames, ct);
                return new { path = "runtime", frames };
            case "runtime.advance":
                var ticks = RpArgs.Int(args, "ticks", 1);
                if (ticks < 1 || ticks > 10000000) throw new RpException("INVALID_ARGUMENT", "ticks must be 1..10000000.");
                var result = await RimBridge.Game.StepTicksAsync(ticks, new RimBridgeTickOptions { TimeoutMs = RpArgs.Int(args, "timeoutMs", 30000), PauseFirst = true }, ct);
                return new { path = "runtime", result };
            case "runtime.runUntil":
                var cursor = args.Value<long?>("cursor") ?? JObject.FromObject(RpSession.Poll(long.MaxValue)).Value<long>("cursor");
                var start = await RimBridgeMainThread.InvokeAsync(() => Find.TickManager.TicksGame, ct);
                var maximum = RpArgs.Int(args, "maxTicks", 600);
                var watch = Stopwatch.StartNew();
                while (watch.ElapsedMilliseconds < RpArgs.Int(args, "timeoutMs", 30000)) {
                    ct.ThrowIfCancellationRequested();
                    var events = JObject.FromObject(RpSession.Poll(cursor));
                    var matched = events["events"].FirstOrDefault(e => e.Value<string>("name") == RpArgs.String(args, "event"));
                    if (matched != null) return new { path = "runtime", satisfied = true, reason = "event", matched };
                    if (args["query"] is JObject query && args["equals"] != null) {
                        var actual = await RimBridgeMainThread.InvokeAsync(() => JToken.FromObject(RpStateReader.Invoke("state.read", query)), ct);
                        if (JToken.DeepEquals(actual.SelectToken(RpArgs.String(args, "resultPath", "$")), args["equals"])) return new { path = "runtime", satisfied = true, reason = "condition", actual };
                    }
                    var now = await RimBridgeMainThread.InvokeAsync(() => Find.TickManager.TicksGame, ct);
                    if (now - start >= maximum) return new { path = "runtime", satisfied = false, reason = "maxTicks", elapsedTicks = now - start };
                    await RimBridge.Game.StepTicksAsync(1, new RimBridgeTickOptions { PauseFirst = true, TimeoutMs = 5000 }, ct);
                }
                return new { path = "runtime", satisfied = false, reason = "timeout" };
            case "runtime.save":
                return RpUi.Checked(await Task.Run(() => new RimBridgeTools().SaveGame(Name(args)), ct));
            case "runtime.load":
                var loaded = RpUi.Checked(await Task.Run(() => new RimBridgeTools().LoadGameReady(Name(args), timeoutMs: RpArgs.Int(args, "timeoutMs", 120000), readiness: "visual", pauseIfNeeded: true), ct));
                await RimBridgeMainThread.InvokeAsync(() => { RpSession.RefreshWorld(); return true; }, ct);
                return loaded;
            case "fixture.newGame":
                if (!RpSession.FixtureMode) throw new RpException("FIXTURE_DISABLED", "Launch explicitly with -Fixture to create test fixtures.");
                return RpUi.Checked(await Task.Run(() => new RimBridgeTools().StartDebugGameReady(timeoutMs: 120000, readiness: "visual", pauseIfNeeded: true), ct));
            case "fixture.spawn": return await RimBridgeMainThread.InvokeAsync(() => RpFixture.Spawn(args), ct);
            case "fixture.prepare": return await RimBridgeMainThread.InvokeAsync(() => RpFixture.Prepare(args), ct);
            default: throw new RpException("UNKNOWN_METHOD", method);
        }
    }
    private static string Name(JObject args) {
        var name = RpArgs.String(args, "name");
        if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0) throw new RpException("INVALID_ARGUMENT", "Supply a save name without a path.");
        return name;
    }
}
