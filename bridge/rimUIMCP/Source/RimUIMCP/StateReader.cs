using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal static class RpStateReader
{
    private static readonly Dictionary<Type, FieldInfo[]> FieldCache = new();
    private static readonly Dictionary<Type, Dictionary<string, FieldInfo>> FieldNameCache = new();
    private sealed class Budget
    {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private int nodes;
        public readonly int Limit;
        public readonly int Milliseconds;
        public Budget(JObject args) { Limit = Math.Max(1, Math.Min(100000, RpArgs.Int(args, "maxNodes", 10000))); Milliseconds = Math.Max(1, Math.Min(1000, RpArgs.Int(args, "budgetMs", 50))); }
        public void Step() { if (++nodes > Limit || clock.ElapsedMilliseconds > Milliseconds) throw new RpException("BUDGET_EXCEEDED", "Observation budget exceeded; narrow fields or collection range.", new { nodes, elapsedMs = clock.ElapsedMilliseconds }); }
    }
    private static FieldInfo[] Fields(Type type)
    {
        if (FieldCache.TryGetValue(type, out var cached)) return cached;
        var result = new List<FieldInfo>();
        for (var current = type; current != null; current = current.BaseType)
            result.AddRange(current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        return FieldCache[type] = result.ToArray();
    }
    private static object Field(object value, string name)
    {
        if (value == null) return null;
        if (value is JObject json) return json[name];
        if (value is IDictionary dictionary && dictionary.Contains(name)) return dictionary[name];
        var type = value.GetType();
        if (!FieldNameCache.TryGetValue(type, out var map)) {
            map = new Dictionary<string, FieldInfo>();
            foreach (var candidate in Fields(type)) if (!map.ContainsKey(candidate.Name)) map[candidate.Name] = candidate;
            FieldNameCache[type] = map;
        }
        if (!map.TryGetValue(name, out var field)) map.TryGetValue("<" + name + ">k__BackingField", out field);
        if (field == null) throw new RpException("FIELD_NOT_FOUND", "No readable field '" + name + "' on " + value.GetType().FullName + ". Use state.describe; arbitrary getters and methods are not executed.");
        return field.GetValue(value);
    }
    private static object Path(object value, string path)
    {
        foreach (var component in (path ?? "").Split(new[] { '.' }, StringSplitOptions.RemoveEmptyEntries)) {
            if (value is IList list && int.TryParse(component, out var index)) {
                if (index < 0 || index >= list.Count) throw new RpException("INVALID_ARGUMENT", "Collection index out of range.");
                value = list[index];
            } else value = Field(value, component);
        }
        return value;
    }
    public static Thing Thing(string id)
    {
        var result = Find.Maps?.SelectMany(m => m.listerThings.AllThings).FirstOrDefault(t => t.ThingID == id);
        if (result == null) throw new RpException("TARGET_GONE", "No spawned thing with ID " + id);
        return result;
    }
    public static object Pawn(Pawn pawn)
    {
        var result = JObject.FromObject(RimWorldState.DescribePawn(pawn));
        result["id"] = pawn.ThingID;
        result["ref"] = JObject.FromObject(RpSession.Reference(pawn));
        result["hostile"] = pawn.HostileTo(Faction.OfPlayer);
        result["colonist"] = pawn.IsColonistPlayerControlled;
        result["drafted"] = pawn.Drafted;
        result["downed"] = pawn.Downed;
        result["dead"] = pawn.Dead;
        result["position"] = JObject.FromObject(new { x = pawn.Position.x, z = pawn.Position.z });
        result["health"] = JObject.FromObject(new { summary = pawn.health.summaryHealth.SummaryHealthPercent,
            conditions = pawn.health.hediffSet.hediffs.Select(h => new { def = h.def.defName, severity = h.Severity, part = h.Part?.def?.defName, reference = RpSession.Reference(h) }).ToArray() });
        result["needs"] = JObject.FromObject(new { food = pawn.needs?.food?.CurLevelPercentage, rest = pawn.needs?.rest?.CurLevelPercentage, mood = pawn.needs?.mood?.CurLevelPercentage });
        result["skills"] = JArray.FromObject(pawn.skills?.skills.Select(s => new { def = s.def.defName, level = s.Level, passion = s.passion.ToString(), disabled = s.TotallyDisabled }).ToArray() ?? new object[0]);
        result["work"] = JObject.FromObject(DefDatabase<WorkTypeDef>.AllDefsListForReading.ToDictionary(d => d.defName, d => new { priority = pawn.workSettings?.GetPriority(d) ?? 0, disabled = pawn.WorkTypeIsDisabled(d) }));
        result["equipment"] = JArray.FromObject(pawn.equipment?.AllEquipmentListForReading.Select(e => new { id = e.ThingID, def = e.def.defName, reference = RpSession.Reference(e) }).ToArray() ?? new object[0]);
        result["currentJob"] = pawn.CurJob == null ? null : JObject.FromObject(new { def = pawn.CurJob.def.defName, reference = RpSession.Reference(pawn.CurJob) });
        return result;
    }
    private static object Root(string root, JObject args)
    {
        switch (root ?? "game") {
            case "game": return Current.Game;
            case "maps": return Find.Maps;
            case "currentMap": return Find.CurrentMap;
            case "world": return Find.World;
            case "ui": return Find.WindowStack;
            case "selection": return Current.ProgramState == ProgramState.Playing ? Find.Selector : null;
            case "designator": return Current.ProgramState == ProgramState.Playing ? Find.DesignatorManager : null;
            case "ticks": return Find.TickManager;
            case "research": return Find.ResearchManager;
            case "letters": return Find.LetterStack;
            case "currentMap.pawns": return Find.CurrentMap?.mapPawns.AllPawnsSpawned;
            case "currentMap.things": return Find.CurrentMap?.listerThings.AllThings;
            case "currentMap.blueprints": return Find.CurrentMap?.listerThings.ThingsInGroup(ThingRequestGroup.Blueprint);
            case "currentMap.items": return Find.CurrentMap?.listerThings.ThingsInGroup(ThingRequestGroup.HaulableEver);
            case "currentMap.buildings": return Find.CurrentMap?.listerBuildings.allBuildingsColonist;
            case "defs":
                var typeName = RpArgs.String(args, "type", "Verse.ThingDef");
                var type = typeof(Def).Assembly.GetTypes().FirstOrDefault(t => (t.FullName == typeName || t.Name == typeName) && typeof(Def).IsAssignableFrom(t));
                if (type == null) throw new RpException("INVALID_ARGUMENT", "Unknown Def type " + typeName);
                return typeof(DefDatabase<>).MakeGenericType(type).GetProperty("AllDefsListForReading", BindingFlags.Public | BindingFlags.Static).GetValue(null);
            default: throw new RpException("INVALID_ARGUMENT", "Unknown root; discover roots with state.roots.");
        }
    }
    private static IEnumerable Materialized(object value) {
        if (value is IList list) return list;
        if (value is IDictionary dictionary) return dictionary;
        if (value is not IEnumerable sequence) return null;
        var type = value.GetType();
        if (!type.IsGenericType) return value is Queue || value is Stack ? sequence : null;
        var generic = type.GetGenericTypeDefinition();
        return generic == typeof(HashSet<>) || generic == typeof(Queue<>) || generic == typeof(Stack<>) || generic == typeof(LinkedList<>) ? sequence : null;
    }
    private static object Scalar(object value, int depth, Budget budget)
    {
        budget.Step();
        if (value == null) return null;
        if (value is JToken token) return token.DeepClone();
        var type = value.GetType();
        if (type.IsPrimitive || value is string || value is decimal) return value;
        if (type.IsEnum || value is Guid || value is DateTime) return value.ToString();
        if (value is IntVec3 cell) return new { x = cell.x, y = cell.y, z = cell.z };
        if (value is Vector3 vector) return new { x = vector.x, y = vector.y, z = vector.z };
        if (value is TaggedString tagged) return tagged.ToString();
        if (depth <= 0) return RpSession.Reference(value);
        if (value is IDictionary dict) {
            var entries = new List<object>();
            foreach (DictionaryEntry entry in dict) entries.Add(new { key = Scalar(entry.Key, depth - 1, budget), value = Scalar(entry.Value, depth - 1, budget) });
            return new { reference = RpSession.Reference(value), entries };
        }
        if (value is IList list) {
            var items = new List<object>();
            foreach (var item in list) items.Add(Scalar(item, depth - 1, budget));
            return new { reference = RpSession.Reference(value), items };
        }
        var fields = new Dictionary<string, object>();
        foreach (var field in Fields(type)) { budget.Step(); if (!fields.ContainsKey(field.Name)) fields[field.Name] = Scalar(field.GetValue(value), depth - 1, budget); }
        return new { reference = RpSession.Reference(value), fields };
    }
    public static object Invoke(string method, JObject args)
    {
        RpSession.RefreshWorld();
        var budget = new Budget(args);
        var limit = Math.Max(1, Math.Min(50000, RpArgs.Int(args, "limit", 100)));
        var offset = Math.Max(0, RpArgs.Int(args, "cursor", RpArgs.Int(args, "offset", 0)));
        if (method == "state.roots") return new {
            game = RpSession.Reference(Current.Game), currentMap = RpSession.Reference(Find.CurrentMap), maps = RpSession.Reference(Find.Maps),
            world = RpSession.Reference(Current.Game == null ? null : Find.World), research = RpSession.Reference(Current.Game == null ? null : Find.ResearchManager), letters = RpSession.Reference(Current.Game == null ? null : Find.LetterStack),
            ui = RpSession.Reference(Find.WindowStack),
            selection = RpSession.Reference(Root("selection", args)), designator = RpSession.Reference(Root("designator", args)), ticks = RpSession.Reference(Current.Game == null ? null : Find.TickManager),
            collections = new[] { "currentMap.pawns", "currentMap.things", "currentMap.blueprints", "currentMap.items", "currentMap.buildings", "defs" },
            defTypes = typeof(Def).Assembly.GetTypes().Where(t => !t.IsAbstract && typeof(Def).IsAssignableFrom(t)).Select(t => t.FullName).ToArray()
        };
        if (Current.Game == null && new[] { "state.pawns", "state.bills", "state.notifications", "state.research" }.Contains(method)) throw new RpException("GAME_NOT_READY", "Load a colony before querying colony state.");
        if (method == "state.pawns") {
            var pawns = (Find.Maps ?? new List<Map>()).SelectMany(m => m.mapPawns.AllPawnsSpawned)
                .Where(p => !RpArgs.Bool(args, "colonistsOnly", true) || p.IsColonistPlayerControlled).ToArray();
            var items = pawns.Skip(offset).Take(limit).Select(p => { budget.Step(); return Pawn(p); }).ToArray();
            var nextCursor = offset + items.Length < pawns.Length ? (int?)(offset + items.Length) : null;
            return new { items, total = pawns.Length, offset, limit, nextCursor, truncated = nextCursor != null };
        }
        if (method == "state.world" || method == "state.worldTile") return RpWorldInput.Observe(method, args);
        if (method == "state.map") {
            var map = Find.CurrentMap ?? throw new RpException("GAME_NOT_READY", "No current map.");
            return new { id = RimWorldState.GetMapId(map), reference = RpSession.Reference(map), width = map.Size.x, height = map.Size.z,
                biome = map.Biome.defName, things = map.listerThings.AllThings.Count,
                buildings = map.listerBuildings.allBuildingsColonist.Select(b => new { id = b.ThingID, def = b.def.defName, position = new { x = b.Position.x, z = b.Position.z }, reference = RpSession.Reference(b) }).ToArray() };
        }
        if (method == "state.research") return new { current = Find.ResearchManager?.GetProject()?.defName,
            projects = DefDatabase<ResearchProjectDef>.AllDefsListForReading.Select(d => new { id = d.defName, label = d.LabelCap.ToString(), completed = d.IsFinished, progress = d.ProgressReal, cost = d.Cost, reference = RpSession.Reference(d) }).ToArray() };
        if (method == "state.bills") return new { items = Find.Maps.SelectMany(m => m.listerThings.AllThings).OfType<IBillGiver>()
            .Select(g => new { owner = RpSession.Reference(g), bills = g.BillStack.Bills.Select(b => new { recipe = b.recipe.defName, label = b.Label, reference = RpSession.Reference(b) }).ToArray() }).ToArray() };
        if (method == "state.notifications") return Scalar(Find.LetterStack.LettersListForReading, 1, budget);
        var target = args["ref"] != null ? RpSession.Resolve(args["ref"]) : Root(RpArgs.String(args, "root"), args);
        if (args["thingId"] != null) target = Thing(args.Value<string>("thingId"));
        if (args["path"] != null) target = Path(target, args.Value<string>("path"));
        if (method == "state.describe") {
            if (target == null) return new { type = (string)null, fields = new object[0] };
            return new { reference = RpSession.Reference(target), type = target.GetType().FullName,
                fields = Fields(target.GetType()).Select(f => new { name = f.Name, type = f.FieldType.FullName, declaringType = f.DeclaringType.FullName, visibility = f.IsPublic ? "public" : "private", readable = true }).ToArray(),
                properties = target.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Select(p => new { name = p.Name, type = p.PropertyType.FullName, readable = false, reason = "getter_not_invoked" }).ToArray() };
        }
        if (method == "state.read" && args["fields"] is JArray names) {
            var data = new Dictionary<string, object>();
            foreach (var field in names.Values<string>()) data[field] = Scalar(Path(target, field), Math.Min(8, RpArgs.Int(args, "depth", 0)), budget);
            return new { reference = RpSession.Reference(target), fields = data };
        }
        if (method == "state.query" || (method == "state.read" && Materialized(target) != null)) {
            if (target == null) return new { items = new object[0], total = 0, nextCursor = (int?)null };
            var items = new List<object>(); int matched = 0;
            // Do not execute arbitrary IEnumerable iterators supplied by mods. Materialized collections only.
            IEnumerable collection = Materialized(target) ?? throw new RpException("INVALID_ARGUMENT", "Query target must be a materialized list, dictionary, set, queue or stack.");
            foreach (var item in collection) {
                budget.Step();
                object view = item;
                if (item is Pawn pawn && RpArgs.Bool(args, "derived", true)) view = Pawn(pawn);
                if (args["where"] is JObject where && !where.Properties().All(p => JToken.DeepEquals(JToken.FromObject(Scalar(Path(view, p.Name), 0, budget) ?? JValue.CreateNull()), p.Value))) continue;
                if (matched++ < offset) continue;
                if (items.Count >= limit) continue;
                if (args["fields"] is JArray projection) {
                    var projected = new Dictionary<string, object>();
                    foreach (var name in projection.Values<string>()) projected[name] = Scalar(Path(view, name), 0, budget);
                    items.Add(projected);
                } else if (item is DictionaryEntry entry) items.Add(new { key = Scalar(entry.Key, 0, budget), value = Scalar(entry.Value, 0, budget) });
                else items.Add(Scalar(view, Math.Min(8, RpArgs.Int(args, "depth", 0)), budget));
            }
            return new { reference = RpSession.Reference(target), items, total = matched, nextCursor = offset + items.Count < matched ? (int?)(offset + items.Count) : null, consistency = "single-observation" };
        }
        if (method == "state.read") return Scalar(target, Math.Min(8, RpArgs.Int(args, "depth", 0)), budget);
        throw new RpException("UNKNOWN_METHOD", method);
    }
}
