using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace RimUIMCP;

// Both indexes are weak: observing a Job must not keep its pawn/world graph alive.
// Capacity eviction invalidates a handle, never the underlying game object.
internal sealed class ObjectReferenceTable
{
    private sealed class Entry
    {
        public readonly string Id;
        public readonly WeakReference<object> Target;
        public LinkedListNode<Entry> Node;

        public Entry(string id, object target)
        {
            Id = id;
            Target = new WeakReference<object>(target);
        }
    }

    internal readonly struct Snapshot
    {
        public readonly int Capacity, Count;
        public readonly long Issued, Collected, Evicted;
        public Snapshot(int capacity, int count, long issued, long collected, long evicted)
        {
            Capacity = capacity; Count = count; Issued = issued;
            Collected = collected; Evicted = evicted;
        }
    }

    private readonly object sync = new();
    private readonly int capacity, sweepBudget;
    private ConditionalWeakTable<object, Entry> byObject = new();
    private readonly Dictionary<string, Entry> byId = new(StringComparer.Ordinal);
    private readonly LinkedList<Entry> recency = new();
    private LinkedListNode<Entry> scan;
    private long issued, collected, evicted;

    public ObjectReferenceTable(int capacity = 100000, int sweepBudget = 8)
    {
        if (capacity < 1) throw new ArgumentOutOfRangeException(nameof(capacity));
        if (sweepBudget < 1) throw new ArgumentOutOfRangeException(nameof(sweepBudget));
        this.capacity = capacity;
        this.sweepBudget = sweepBudget;
    }

    public Snapshot Statistics
    {
        get { lock (sync) return new Snapshot(capacity, byId.Count, issued, collected, evicted); }
    }

    public string GetOrAdd(object value)
    {
        if (value == null) return null;
        lock (sync)
        {
            SweepCore(sweepBudget);
            if (byObject.TryGetValue(value, out var entry))
            {
                Touch(entry);
                return entry.Id;
            }
            if (byId.Count >= capacity)
            {
                Remove(recency.First.Value);
                evicted++;
            }
            entry = new Entry("obj:" + ++issued, value);
            entry.Node = recency.AddLast(entry);
            byId.Add(entry.Id, entry);
            byObject.Add(value, entry);
            return entry.Id;
        }
    }

    public bool TryResolve(string id, out object value)
    {
        lock (sync)
        {
            value = null;
            if (id == null || !byId.TryGetValue(id, out var entry)) return false;
            if (!entry.Target.TryGetTarget(out value))
            {
                Remove(entry);
                collected++;
                return false;
            }
            Touch(entry);
            return true;
        }
    }

    public bool WasIssued(string id)
    {
        lock (sync)
            return id != null && id.StartsWith("obj:", StringComparison.Ordinal)
                && long.TryParse(id.Substring(4), out var number) && number > 0 && number <= issued;
    }

    // Incremental scanning bounds work even when many observations use a full table.
    public int Sweep(int budget)
    {
        if (budget < 0) throw new ArgumentOutOfRangeException(nameof(budget));
        lock (sync) return SweepCore(budget);
    }

    private int SweepCore(int budget)
    {
        var removed = 0;
        var visits = Math.Min(budget, byId.Count);
        for (var i = 0; i < visits && recency.First != null; i++)
        {
            var node = scan ?? recency.First;
            scan = node.Next ?? recency.First;
            if (ReferenceEquals(scan, node)) scan = null;
            if (!node.Value.Target.TryGetTarget(out _))
            {
                Remove(node.Value);
                collected++;
                removed++;
            }
        }
        return removed;
    }

    private void Touch(Entry entry)
    {
        var node = entry.Node;
        if (ReferenceEquals(node, recency.Last)) return;
        if (ReferenceEquals(scan, node)) scan = node.Next ?? recency.First;
        recency.Remove(node);
        recency.AddLast(node);
    }

    private void Remove(Entry entry)
    {
        var node = entry.Node;
        if (ReferenceEquals(scan, node))
        {
            scan = node.Next ?? recency.First;
            if (ReferenceEquals(scan, node)) scan = null;
        }
        byId.Remove(entry.Id);
        recency.Remove(node);
        entry.Node = null;
        if (entry.Target.TryGetTarget(out var target)) byObject.Remove(target);
    }

    public void Clear()
    {
        lock (sync)
        {
            byObject = new ConditionalWeakTable<object, Entry>();
            byId.Clear();
            recency.Clear();
            scan = null;
            collected = evicted = 0;
            // Keep issued monotonic. An old ID must never alias a later object.
        }
    }
}
