using System;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using RimUIMCP;
using Xunit;

public sealed class ObjectReferenceTableTests
{
    private sealed class EqualObject
    {
        public override bool Equals(object obj) => obj is EqualObject;
        public override int GetHashCode() => 1;
    }

    [Fact]
    public void UsesIdentityAndKeepsAResolvedObjectStable()
    {
        var table = new ObjectReferenceTable(4);
        var a = new EqualObject();
        var b = new EqualObject();
        var id = table.GetOrAdd(a);
        Assert.Equal(id, table.GetOrAdd(a));
        Assert.NotEqual(id, table.GetOrAdd(b));
        Assert.True(table.TryResolve(id, out var resolved));
        Assert.Same(a, resolved);
        GC.KeepAlive(b);
    }

    [Fact]
    public void EvictsLeastRecentlyUsedHandleAndAllowsNewReferences()
    {
        var table = new ObjectReferenceTable(2);
        var a = new object(); var b = new object(); var c = new object();
        var aId = table.GetOrAdd(a); var bId = table.GetOrAdd(b);
        Assert.True(table.TryResolve(aId, out _));
        var cId = table.GetOrAdd(c);
        Assert.True(table.TryResolve(aId, out _));
        Assert.False(table.TryResolve(bId, out _));
        Assert.True(table.WasIssued(bId));
        Assert.True(table.TryResolve(cId, out _));
        var renewed = table.GetOrAdd(b);
        Assert.NotEqual(bId, renewed);
        Assert.False(table.TryResolve(bId, out _));
        Assert.Equal(2, table.Statistics.Count);
        Assert.Equal(2, table.Statistics.Evicted);
        GC.KeepAlive(a); GC.KeepAlive(b); GC.KeepAlive(c);
    }

    [Fact]
    public void RepeatedReferenceAlsoRefreshesRecency()
    {
        var table = new ObjectReferenceTable(2);
        var a = new object(); var b = new object(); var c = new object();
        var aId = table.GetOrAdd(a); var bId = table.GetOrAdd(b);
        Assert.Equal(aId, table.GetOrAdd(a));
        table.GetOrAdd(c);
        Assert.True(table.TryResolve(aId, out _));
        Assert.False(table.TryResolve(bId, out _));
        GC.KeepAlive(a); GC.KeepAlive(b); GC.KeepAlive(c);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (string id, WeakReference<object> weak) ObserveTemporary(ObjectReferenceTable table)
    {
        var value = new object();
        return (table.GetOrAdd(value), new WeakReference<object>(value));
    }

    private static void Collect()
    {
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
    }

    [Fact]
    public void NeitherIndexKeepsObservedObjectsAlive()
    {
        var table = new ObjectReferenceTable();
        var item = ObserveTemporary(table);
        Collect();
        Assert.False(item.weak.TryGetTarget(out _));
        Assert.False(table.TryResolve(item.id, out _));
        Assert.Equal(0, table.Statistics.Count);
        Assert.Equal(1, table.Statistics.Collected);
        Assert.True(table.WasIssued(item.id));
    }

    [Fact]
    public void IncrementalSweepReachesDeadEntriesBehindLiveEntries()
    {
        var table = new ObjectReferenceTable(64, 1);
        var live = Enumerable.Range(0, 8).Select(_ => new object()).ToArray();
        foreach (var value in live) table.GetOrAdd(value);
        var dead = Enumerable.Range(0, 12).Select(_ => ObserveTemporary(table)).ToArray();
        Collect();
        for (var i = 0; i < 32; i++) table.Sweep(1);
        Assert.Equal(live.Length, table.Statistics.Count);
        Assert.Equal(dead.Length, table.Statistics.Collected);
        foreach (var item in dead) Assert.False(table.TryResolve(item.id, out _));
        GC.KeepAlive(live);
    }

    [Fact]
    public void ChurnBeyondCapacityRemainsBoundedWithoutBudgetFailure()
    {
        var table = new ObjectReferenceTable(7, 2);
        var objects = Enumerable.Range(0, 1000).Select(_ => new object()).ToArray();
        var ids = objects.Select(table.GetOrAdd).ToArray();
        Assert.Equal(7, table.Statistics.Count);
        Assert.Equal(993, table.Statistics.Evicted);
        Assert.Equal(ids.Length, ids.Distinct().Count());
        Assert.False(table.TryResolve(ids[0], out _));
        Assert.True(table.TryResolve(ids.Last(), out var last));
        Assert.Same(objects.Last(), last);
        GC.KeepAlive(objects);
    }

    [Fact]
    public void ClearInvalidatesOldHandlesWithoutReusingIds()
    {
        var table = new ObjectReferenceTable();
        var value = new object(); var oldId = table.GetOrAdd(value);
        table.Clear();
        Assert.Equal(0, table.Statistics.Count);
        Assert.False(table.TryResolve(oldId, out _));
        Assert.True(table.WasIssued(oldId));
        Assert.NotEqual(oldId, table.GetOrAdd(value));
    }

    [Fact]
    public void ProductionCapacityAcceptsMoreThanOneHundredThousandObjects()
    {
        var table = new ObjectReferenceTable();
        var objects = Enumerable.Range(0, 100005).Select(_ => new object()).ToArray();
        var ids = objects.Select(table.GetOrAdd).ToArray();
        Assert.Equal(100000, table.Statistics.Count);
        Assert.Equal(5, table.Statistics.Evicted);
        Assert.False(table.TryResolve(ids[0], out _));
        Assert.True(table.TryResolve(ids.Last(), out var last));
        Assert.Same(objects.Last(), last);
        GC.KeepAlive(objects);
    }

    [Fact]
    public void CapacityOneHandlesSweepAndEvictionCursorEdges()
    {
        var table = new ObjectReferenceTable(1, 8);
        var a = new object(); var b = new object();
        var old = table.GetOrAdd(a); table.Sweep(100);
        var current = table.GetOrAdd(b); table.Sweep(100);
        Assert.False(table.TryResolve(old, out _));
        Assert.True(table.TryResolve(current, out _));
        table.Clear(); table.Sweep(100);
        Assert.Equal(0, table.Statistics.Count);
        GC.KeepAlive(a); GC.KeepAlive(b);
    }

    [Fact]
    public void ConcurrentObservationDoesNotSplitIdentity()
    {
        var table = new ObjectReferenceTable(); var value = new object();
        var ids = new string[100];
        Parallel.For(0, ids.Length, i => ids[i] = table.GetOrAdd(value));
        Assert.Single(ids.Distinct());
        Assert.Equal(1, table.Statistics.Count);
    }

    [Fact]
    public void UnknownAndNullIdsAreNotPreviouslyIssuedHandles()
    {
        var table = new ObjectReferenceTable();
        Assert.Null(table.GetOrAdd(null));
        Assert.False(table.TryResolve(null, out _));
        Assert.False(table.WasIssued(null));
        Assert.False(table.WasIssued("obj:1"));
        Assert.False(table.WasIssued("obj:-1"));
        Assert.False(table.WasIssued("something-else"));
        Assert.Throws<ArgumentOutOfRangeException>(() => new ObjectReferenceTable(0));
    }
}
