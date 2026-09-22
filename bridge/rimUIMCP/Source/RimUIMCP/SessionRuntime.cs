using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

// The game owns identity and the UI turn. Nobody waits while blocking its main thread.
internal static class RpSession
{
    public static string SessionId { get; } = Guid.NewGuid().ToString("N");
    public static int WorldEpoch { get; private set; }
    public static bool FixtureMode => Environment.GetEnvironmentVariable("RIMUIMCP_FIXTURE") == "1";
    private static Game _world;
    private static long _snapshot;
    private static readonly ObjectReferenceTable References = new();
    private static readonly SemaphoreSlim UiGate = new(1, 1);
    private static readonly object Sync = new();
    private static readonly Dictionary<string, CancellationTokenSource> Scripts = new(StringComparer.Ordinal);
    private static readonly Queue<object> Events = new();
    private static long _eventCursor;
    private static string _leaseToken;
    private static string _leaseOwner;
    private static DateTime _leaseDeadline;
    private static TaskCompletionSource<bool> _leaseReleased = Signal();
    private static string _lastWindows = "";
    private static string _lastSelection = "";
    private static readonly HashSet<string> Downed = new(StringComparer.Ordinal);
    private static readonly HashSet<int> Letters = new();
    private static int lastLoadedEpoch = -1;
    public static string LastAction { get; private set; } = "Bridge ready";
    public static long ActionsCompleted { get; private set; }

    private static TaskCompletionSource<bool> Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public static void RefreshWorld()
    {
        if (ReferenceEquals(_world, Current.Game)) return;
        _world = Current.Game;
        WorldEpoch++;
        References.Clear(); Downed.Clear(); Letters.Clear();
        RimBridgeVirtualPointer.ClearPersistentPointer();
        RimBridgeUiWorkbench.ClearHoveredElement();
        Publish("session.changed", new { worldEpoch = WorldEpoch, loaded = _world != null });
    }

    public static object Meta()
    {
        RefreshWorld();
        return new {
            sessionId = SessionId, worldEpoch = WorldEpoch,
            mapId = Find.CurrentMap == null ? null : RimWorldState.GetMapId(Find.CurrentMap),
            gameTick = Current.Game == null ? 0 : Find.TickManager?.TicksGame ?? 0,
            uiFrame = Time.frameCount,
            snapshotId = SessionId + ":" + WorldEpoch + ":" + Interlocked.Increment(ref _snapshot)
        };
    }

    public static void CheckEpoch(int? epoch)
    {
        RefreshWorld();
        if (epoch.HasValue && epoch.Value != WorldEpoch)
            throw new RpException("STALE_REFERENCE", "The world was loaded or replaced; query a new reference.", new { expected = WorldEpoch, received = epoch });
    }

    public static ObjectRef Reference(object value)
    {
        RefreshWorld();
        if (value == null) return null;
        var id = References.GetOrAdd(value);
        return new ObjectRef { id = id, sessionId = SessionId, worldEpoch = WorldEpoch, type = value.GetType().FullName };
    }

    public static object Resolve(JToken reference)
    {
        RefreshWorld();
        if (reference is not JObject obj) throw new RpException("STALE_REFERENCE", "Supply an ObjectRef with sessionId and worldEpoch.");
        if (obj.Value<string>("sessionId") != SessionId || obj.Value<int?>("worldEpoch") != WorldEpoch)
            throw new RpException("STALE_REFERENCE", "Reference belongs to another game session or world.");
        var id = obj.Value<string>("id");
        if (!References.TryResolve(id, out var value)) {
            if (References.WasIssued(id)) throw new RpException("STALE_REFERENCE", "Object handle was collected or evicted; query a fresh reference.", new { reason = "reference-expired", id });
            throw new RpException("TARGET_GONE", "Object reference does not exist.");
        }
        if (value is Thing thing && thing.Destroyed) throw new RpException("TARGET_GONE", "Referenced thing has been destroyed.");
        return value;
    }

    private static object ReferenceStatus() {
        var stats = References.Statistics;
        return new { capacity = stats.Capacity, indexed = stats.Count, issued = stats.Issued, collected = stats.Collected, evicted = stats.Evicted };
    }

    public static object Status() => new {
        apiVersion = 1, sessionId = SessionId, worldEpoch = WorldEpoch,
        fixtureMode = FixtureMode, programState = Current.ProgramState.ToString(),
        gameLoaded = Current.Game != null, mapLoaded = Find.CurrentMap != null, loading = LongEventHandler.AnyEventNowOrWaiting,
        gameVersion = VersionControl.CurrentVersionString,
        modRoot = LoadedModManager.GetMod<RimUIMCPMod>()?.Content?.RootDir,
        capabilities = RpTools.Methods, completedActions = ActionsCompleted,
        patches = RimBridgePatches.DescribeStatus(), referenceCache = ReferenceStatus(),
        ui = new { occupied = _leaseToken != null, owner = _leaseOwner },
        observation = Meta()
    };

    public static CancellationToken ScriptToken(string scriptId)
    {
        if (string.IsNullOrWhiteSpace(scriptId)) return CancellationToken.None;
        lock (Sync) {
            if (!Scripts.TryGetValue(scriptId, out var source)) Scripts[scriptId] = source = new CancellationTokenSource();
            return source.Token;
        }
    }

    public static object Cancel(string scriptId)
    {
        if (string.IsNullOrWhiteSpace(scriptId)) throw new RpException("INVALID_ARGUMENT", "scriptId is required.");
        lock (Sync) {
            if (Scripts.TryGetValue(scriptId, out var source)) source.Cancel();
            if (_leaseOwner == scriptId) ReleaseLease();
        }
        Publish("script.cancelled", new { scriptId });
        return new { scriptId, cancelled = true, completedInputsRolledBack = false };
    }

    public static object Finish(string scriptId, string status) {
        if (string.IsNullOrWhiteSpace(scriptId)) throw new RpException("INVALID_ARGUMENT", "scriptId is required.");
        if (status != "succeeded" && status != "failed") throw new RpException("INVALID_ARGUMENT", "Finished status must be succeeded or failed.");
        lock (Sync) {
            if (Scripts.TryGetValue(scriptId, out var source)) { source.Cancel(); source.Dispose(); Scripts.Remove(scriptId); }
            if (_leaseOwner == scriptId) ReleaseLease();
        }
        Publish("script." + status, new { scriptId });
        return new { scriptId, status };
    }

    // Reserves the UI sequence for a specific script ID using a token. The serialized path checks
    // for expiry and renews a two-minute deadline when owner requests pass the gate. It is
    // designed for short multi-step interactions; the caller controls simulation time, and
    // already-applied inputs remain in effect.
    public static async Task<object> BeginSequence(string scriptId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(scriptId)) throw new RpException("INVALID_ARGUMENT", "A sequence needs a scriptId/client owner.");
        return await Serialized(scriptId, null, async () => {
            string token;
            lock (Sync) {
                token = Guid.NewGuid().ToString("N"); _leaseToken = token; _leaseOwner = scriptId;
                _leaseDeadline = DateTime.UtcNow.AddMinutes(2); _leaseReleased = Signal();
            }
            await Task.CompletedTask;
            return (object)new { token, sequenceToken = token, scriptId };
        }, ct).ConfigureAwait(false);
    }

    public static object EndSequence(string scriptId, string token)
    {
        lock (Sync) {
            if (_leaseToken == null) return new { released = true };
            if (token != _leaseToken || scriptId != _leaseOwner) throw new RpException("STALE_REFERENCE", "Sequence token does not own the current UI sequence.");
            ReleaseLease();
        }
        return new { released = true };
    }

    private static void ReleaseLease()
    {
        _leaseToken = null; _leaseOwner = null; _leaseReleased.TrySetResult(true);
    }

    public static async Task<object> Serialized(string scriptId, string token, Func<Task<object>> action, CancellationToken ct)
    {
        while (true) {
            Task released = null;
            lock (Sync) {
                if (_leaseToken != null && DateTime.UtcNow > _leaseDeadline) ReleaseLease();
                if (_leaseToken != null && (_leaseToken != token || _leaseOwner != scriptId)) released = _leaseReleased.Task;
                else if (token != null && _leaseToken != token) throw new RpException("STALE_REFERENCE", "UI sequence has expired.");
            }
            if (released != null) { await WaitCancelable(released, ct).ConfigureAwait(false); continue; }
            await UiGate.WaitAsync(ct).ConfigureAwait(false);
            lock (Sync) {
                if (_leaseToken != null && (_leaseToken != token || _leaseOwner != scriptId)) { UiGate.Release(); continue; }
                if (_leaseToken != null) _leaseDeadline = DateTime.UtcNow.AddMinutes(2);
            }
            try { ct.ThrowIfCancellationRequested(); return await action().ConfigureAwait(false); }
            finally { UiGate.Release(); }
        }
    }

    private static async Task WaitCancelable(Task task, CancellationToken ct)
    {
        var cancelled = Signal();
        using (ct.Register(() => cancelled.TrySetCanceled())) {
            var completed = await Task.WhenAny(task, cancelled.Task).ConfigureAwait(false);
            await completed.ConfigureAwait(false);
        }
    }

    public static void Publish(string name, object data)
    {
        lock (Sync) {
            Events.Enqueue(new { cursor = ++_eventCursor, name, sessionId = SessionId, worldEpoch = WorldEpoch,
                utc = DateTime.UtcNow.ToString("o"), data });
            while (Events.Count > 2048) Events.Dequeue();
        }
    }

    public static object Poll(long cursor)
    {
        lock (Sync) {
            var oldest = Math.Max(1, _eventCursor - Events.Count + 1);
            return new { cursor = _eventCursor, gap = cursor > 0 && cursor < oldest - 1,
                events = Events.Select(JObject.FromObject).Where(e => e.Value<long>("cursor") > cursor).ToArray() };
        }
    }

    public static void ActionCompleted(string method)
    {
        lock (Sync) { LastAction = method; ActionsCompleted++; }
    }

    public static void OnFrame()
    {
        lock (Sync) { if (_leaseToken != null && DateTime.UtcNow > _leaseDeadline) ReleaseLease(); }
        RefreshWorld();
        if (Find.WindowStack != null) {
            var windows = string.Join("|", Find.WindowStack.Windows.Select(w => w.GetType().FullName + ":" + RuntimeHelpers.GetHashCode(w)));
            if (windows != _lastWindows) { _lastWindows = windows; Publish("ui.windowsChanged", new { windows }); }
        }
        if (Current.ProgramState != ProgramState.Playing || Find.CurrentMap == null) return;
        if (lastLoadedEpoch != WorldEpoch && !LongEventHandler.AnyEventNowOrWaiting) {
            lastLoadedEpoch = WorldEpoch;
            Publish("session.loaded", new { mapId = RimWorldState.GetMapId(Find.CurrentMap), gameTick = Find.TickManager.TicksGame });
        }
        var selection = string.Join("|", Find.Selector.SelectedObjects.Select(o => RuntimeHelpers.GetHashCode(o).ToString()));
        if (selection != _lastSelection) { _lastSelection = selection; Publish("ui.selectionChanged", new { selection }); }
        foreach (var pawn in Find.CurrentMap.mapPawns.AllPawnsSpawned) {
            var id = pawn.ThingID;
            if (pawn.Downed && Downed.Add(id)) Publish("pawn.downed", new { pawnId = id, gameTick = Find.TickManager.TicksGame });
            else if (!pawn.Downed) Downed.Remove(id);
        }
        foreach (var letter in Find.LetterStack.LettersListForReading) {
            if (Letters.Add(letter.ID)) Publish("notification.letter", new { letterId = letter.ID, label = letter.Label.ToString() });
        }
    }
}

[HarmonyPatch(typeof(Root), nameof(Root.Update))]
internal static class RpSessionFramePatch
{
    private static void Postfix()
    {
        try { RpSession.OnFrame(); }
        catch (Exception ex) { Log.ErrorOnce("[rimUIMCP] frame observation failed: " + ex, 991721); }
    }
}
