using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using RimWorld;
using Verse;
using Verse.AI.Group;

namespace RimUIMCP;

// Explicit isolated-test setup. These commands are rejected in a challenge session.
internal static class RpFixture
{
    public static object Prepare(JObject args) {
        if (!RpSession.FixtureMode) throw new RpException("FIXTURE_DISABLED", "Fixture operations require an explicit -Fixture launch.");
        var map = Find.CurrentMap ?? throw new RpException("GAME_NOT_READY", "Load the test colony first.");
        var cell = new IntVec3(RpArgs.Int(args, "x", 140), 0, RpArgs.Int(args, "z", 140));
        if (!cell.InBounds(map)) throw new RpException("INVALID_ARGUMENT", "Fixture cell is outside the map.");
        switch (RpArgs.String(args, "kind")) {
            case "letter":
                Find.LetterStack.ReceiveLetter("rimUIMCP fixture notification", "This is an isolated UI/event acceptance fixture. Open and close it through the actual letter window.", LetterDefOf.NeutralEvent);
                return new { path = "fixture", kind = "letter" };
            case "soil":
                var size = Math.Max(1, Math.Min(20, RpArgs.Int(args, "size", 10)));
                foreach (var c in CellRect.CenteredOn(cell, size, size).ClipInsideMap(map)) {
                    map.terrainGrid.SetTerrain(c, TerrainDefOf.Soil);
                    map.snowGrid.SetDepth(c, 0);
                }
                return new { path = "fixture", kind = "soil", x = cell.x, z = cell.z, size };
            case "trader":
                var faction = Find.FactionManager.AllFactionsListForReading.First(f => !f.IsPlayer && !f.HostileTo(Faction.OfPlayer) && f.def.humanlikeFaction);
                var pawn = PawnGenerator.GeneratePawn(DefDatabase<PawnKindDef>.GetNamed("Town_Trader"), faction);
                pawn.trader ??= new Pawn_TraderTracker(pawn);
                pawn.trader.traderKind = DefDatabase<TraderKindDef>.GetNamed("Caravan_Outlander_BulkGoods");
                pawn.mindState.wantsToTradeWithColony = true;
                foreach (var stock in new[] { ("Silver", 1500), ("Steel", 75), ("Cloth", 50) }) {
                    var item = ThingMaker.MakeThing(DefDatabase<ThingDef>.GetNamed(stock.Item1)); item.stackCount = stock.Item2;
                    pawn.inventory.innerContainer.TryAdd(item);
                }
                GenSpawn.Spawn(pawn, cell, map);
                LordMaker.MakeNewLord(faction, new LordJob_DefendPoint(cell), map, new[] { pawn });
                foreach (var c in CellRect.CenteredOn(cell, 6).ClipInsideMap(map)) map.areaManager.Home[c] = true;
                return new { path = "fixture", kind = "trader", id = pawn.ThingID, reference = RpSession.Reference(pawn), x = cell.x, z = cell.z };
            default: throw new RpException("INVALID_ARGUMENT", "Fixture kind must be soil or trader.");
        }
    }
    public static object Spawn(JObject args) {
        if (!RpSession.FixtureMode) throw new RpException("FIXTURE_DISABLED", "Fixture operations require an explicit -Fixture launch.");
        var map = Find.CurrentMap ?? throw new RpException("GAME_NOT_READY", "Load the test colony first.");
        var def = DefDatabase<ThingDef>.GetNamed(RpArgs.String(args, "def"));
        var cell = new IntVec3(RpArgs.Int(args, "x"), 0, RpArgs.Int(args, "z"));
        if (!cell.InBounds(map)) throw new RpException("INVALID_ARGUMENT", "Fixture cell is outside the map.");
        var stuff = def.MadeFromStuff ? DefDatabase<ThingDef>.GetNamed(RpArgs.String(args, "stuff", "WoodLog")) : null;
        var thing = ThingMaker.MakeThing(def, stuff);
        thing.stackCount = Math.Max(1, Math.Min(def.stackLimit, RpArgs.Int(args, "count", 1)));
        if (def.CanHaveFaction && RpArgs.Bool(args, "playerOwned", true)) thing.SetFaction(Faction.OfPlayer);
        GenSpawn.Spawn(thing, cell, map);
        return new { path = "fixture", id = thing.ThingID, reference = RpSession.Reference(thing), def = def.defName, x = cell.x, z = cell.z };
    }
}
