using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Lib.GAB.Tools;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RimUIMCP;

public sealed class RpTools
{
    public static readonly string[] Methods = {
        "session.status", "session.cancel", "session.finish", "session.sequence.begin", "session.sequence.end", "session.result",
        "state.roots", "state.describe", "state.read", "state.query", "state.pawns", "state.map", "state.world", "state.worldTile", "state.research", "state.bills", "state.notifications",
        "ui.snapshot", "ui.resolve", "ui.read", "ui.input", "ui.panel", "ui.select", "ui.reveal", "ui.screenshot", "map.click", "map.drag", "world.click", "world.reveal",
        "runtime.pause", "runtime.speed", "runtime.nextFrame", "runtime.advance", "runtime.runUntil", "runtime.save", "runtime.load", "events.poll", "fixture.newGame", "fixture.spawn", "fixture.prepare"
    };
    private sealed class Entry { public string Signature; public Task<object> Task; }
    private static readonly Dictionary<string, Entry> Results = new();
    private static readonly object Sync = new();

    [Tool("rimuimcp/call", Description = "rimUIMCP 1.0: discover methods with session.status; freely inspect state and activate real visible UI. No silent native fallback.")]
    public Task<object> Call(string method, Dictionary<string, object> args = null, string requestId = null, string scriptId = null, string sequenceToken = null, int timeoutMs = 30000)
    {
        requestId = string.IsNullOrEmpty(requestId) ? Guid.NewGuid().ToString("N") : requestId;
        var json = args == null ? new JObject() : JObject.FromObject(args);
        var signature = method + "|" + json.ToString(Formatting.None) + "|" + scriptId + "|" + sequenceToken;
        lock (Sync) {
            if (Results.TryGetValue(requestId, out var prior)) {
                if (prior.Signature != signature) return Task.FromResult<object>(new { success = false, requestId, error = new { code = "REQUEST_ID_CONFLICT", message = "requestId was already used with different arguments." } });
                return prior.Task;
            }
            while (Results.Count >= 256) {
                var finished = Results.FirstOrDefault(p => p.Value.Task.IsCompleted);
                if (finished.Key == null) break;
                Results.Remove(finished.Key);
            }
            var task = Execute(method, json, requestId, scriptId, sequenceToken, timeoutMs);
            Results[requestId] = new Entry { Signature = signature, Task = task };
            return task;
        }
    }
    private static async Task<object> Execute(string method, JObject args, string id, string scriptId, string sequenceToken, int timeoutMs)
    {
        object started = null, meta = null, result;
        using var timeout = new CancellationTokenSource(Math.Max(100, Math.Min(1800000, timeoutMs)));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, method == "session.cancel" ? CancellationToken.None : RpSession.ScriptToken(scriptId));
        var ct = linked.Token;
        try {
            started = await RimBridgeMainThread.InvokeAsync(RpSession.Meta, ct);
            object data;
            if (method.StartsWith("state.") || method == "session.status") {
                var observation = await RimBridgeMainThread.InvokeAsync(() => {
                    var value = method == "session.status" ? RpSession.Status() : RpStateReader.Invoke(method, args);
                    return new { value, boundary = RpSession.Meta() };
                }, ct);
                data = observation.value; meta = observation.boundary;
            } else if (method == "events.poll") data = RpSession.Poll(args.Value<long?>("cursor") ?? 0);
            else if (method == "session.cancel") data = RpSession.Cancel(RpArgs.String(args, "scriptId", scriptId));
            else if (method == "session.finish") data = RpSession.Finish(RpArgs.String(args, "scriptId", scriptId), RpArgs.String(args, "status"));
            else if (method == "session.sequence.begin") data = await RpSession.BeginSequence(scriptId, ct);
            else if (method == "session.sequence.end") data = RpSession.EndSequence(scriptId, RpArgs.String(args, "token", sequenceToken));
            else if (method == "session.result") {
                Entry entry;
                lock (Sync) Results.TryGetValue(RpArgs.String(args, "requestId", ""), out entry);
                data = entry == null ? new { status = "unknown" } : entry.Task.IsCompleted ? await entry.Task : new { status = "pending" };
            } else {
                data = await RpSession.Serialized(scriptId, sequenceToken, async () => {
                    if (!Methods.Contains(method)) throw new RpException("UNKNOWN_METHOD", "Unknown method " + method);
                    var value = method.StartsWith("ui.") || method.StartsWith("map.") || method.StartsWith("world.") ? await RpUi.InvokeAsync(method, args, ct) : await RpRuntime.Invoke(method, args, ct);
                    if (method != "ui.snapshot" && method != "ui.resolve" && method != "ui.read") RpSession.ActionCompleted(method);
                    return value;
                }, ct);
            }
            meta ??= await RimBridgeMainThread.InvokeAsync(RpSession.Meta);
            result = new { success = true, requestId = id, meta, data, started, ended = meta };
        } catch (Exception exception) {
            var ex = exception is AggregateException aggregate ? aggregate.GetBaseException() : exception;
            if (ex is not RpException && ex is not OperationCanceledException) Verse.Log.Error("[rimUIMCP] " + method + ": " + ex);
            try { meta = await RimBridgeMainThread.InvokeAsync(RpSession.Meta); } catch { }
            var code = ex is RpException error ? error.Code : ex is OperationCanceledException ? (timeout.IsCancellationRequested ? "TIMEOUT" : "CANCELLED") : "INTERNAL_ERROR";
            result = new { success = false, requestId = id, meta, data = (object)null, started, ended = meta,
                error = new { code, message = ex.Message, details = (ex as RpException)?.Details, outcomeMayHaveChanged = !method.StartsWith("state.") } };
            RpSession.Publish("action.failed", new { scriptId, requestId = id, method, code });
        }
        try {
            var root = Environment.GetEnvironmentVariable("RIMUIMCP_ROOT");
            if (!string.IsNullOrEmpty(root)) {
                var directory = Path.Combine(root, "runs"); Directory.CreateDirectory(directory);
                lock (Sync) File.AppendAllText(Path.Combine(directory, "bridge-" + RpSession.SessionId + ".jsonl"), JsonConvert.SerializeObject(new { utc = DateTime.UtcNow, method, args, scriptId, result }) + "\n");
            }
        } catch (Exception ex) { Verse.Log.ErrorOnce("[rimUIMCP] Cannot write action journal: " + ex.Message, 991724); }
        return result;
    }
}
