using System;
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

// Resolve world identities read-only; dispatch clicks through the same play OnGUI
// injector as colony clicks. Never call selection, route or caravan order methods.
internal static class RpWorldInput
{
    private static void Ready(bool input = false)
    {
        if (Current.ProgramState != ProgramState.Playing || Find.World == null || LongEventHandler.AnyEventNowOrWaiting)
            throw new RpException("GAME_NOT_READY", "Load a world before using world navigation.");
        if (input && !WorldRendererUtility.WorldSelected)
            throw new RpException("UI_BLOCKED", "Open the World panel before world input.");
        if (input && !Find.WindowStack.GetsInput(null))
            throw new RpException("UI_BLOCKED", "Close the blocking dialog before world input.");
    }

    private static PlanetTile Tile(JObject args)
    {
        var layerId = RpArgs.Int(args, "layerId", 0);
        if (!Find.WorldGrid.PlanetLayers.ContainsKey(layerId))
            throw new RpException("INVALID_ARGUMENT", "Unknown planet layer.");
        var tile = new PlanetTile(RpArgs.Int(args, "tileId", -1), layerId);
        if (!Find.WorldGrid.InBounds(tile)) throw new RpException("INVALID_ARGUMENT", "World tile is out of bounds.");
        return tile;
    }

    private static object Identity(PlanetTile tile) => new { tileId = tile.tileId, layerId = tile.Layer.LayerID };

    public static object Observe(string method, JObject args)
    {
        Ready();
        if (method == "state.worldTile") {
            var tile = Tile(args);
            var neighbors = new System.Collections.Generic.List<PlanetTile>();
            Find.WorldGrid.GetTileNeighbors(tile, neighbors);
            var center = Find.WorldGrid.GetTileCenter(tile);
            var coordinates = Find.WorldGrid.LongLatOf(tile);
            return new { tile = Identity(tile), reference = RpSession.Reference(tile.Tile),
                longitude = coordinates.x, latitude = coordinates.y,
                center = new { x = center.x, y = center.y, z = center.z }, neighbors = neighbors.Select(Identity).ToArray() };
        }
        var all = Find.WorldObjects.AllWorldObjects;
        var offset = Math.Max(0, RpArgs.Int(args, "cursor", 0));
        var limit = Math.Max(1, Math.Min(500, RpArgs.Int(args, "limit", 100)));
        var origin = args["originTileId"] == null ? PlanetTile.Invalid : Tile(new JObject {
            ["tileId"] = args["originTileId"], ["layerId"] = args["layerId"] ?? 0 });
        var items = all.Skip(offset).Take(limit).Select(o => new {
            id = o.ID, label = o.Label, type = o.GetType().FullName, tile = Identity(o.Tile), reference = RpSession.Reference(o),
            faction = o.Faction == null ? null : new { name = o.Faction.Name, def = o.Faction.def.defName,
                player = o.Faction.IsPlayer, hostile = o.Faction.HostileTo(Faction.OfPlayer) },
            angularDistanceDegrees = origin.Valid && o.Tile.Valid && origin.Layer == o.Tile.Layer
                ? (float?)Vector3.Angle(Find.WorldGrid.GetTileCenter(origin), Find.WorldGrid.GetTileCenter(o.Tile)) : null
        }).ToArray();
        var planner = Find.WorldRoutePlanner;
        return new { visible = WorldRendererUtility.WorldSelected, selectedTile = Identity(Find.WorldSelector.SelectedTile),
            selectedObjectIds = Find.WorldSelector.SelectedObjects.Select(o => o.ID).ToArray(),
            route = new { active = planner.Active, formingCaravan = planner.FormingCaravan,
                waypoints = planner.waypoints.Select(o => Identity(o.Tile)).ToArray(), reference = RpSession.Reference(planner) },
            items, total = all.Count, offset, limit, nextCursor = offset + items.Length < all.Count ? (int?)(offset + items.Length) : null,
            truncated = offset + items.Length < all.Count };
    }

    public static async Task<object> Input(string method, JObject args, CancellationToken ct)
    {
        var tile = await RimBridgeMainThread.InvokeAsync(() => {
            Ready(true);
            var target = Tile(args);
            if (target.Layer != Find.WorldSelector.SelectedLayer)
                throw new RpException("WRONG_LAYER", "Choose the target planet layer through its UI first.");
            Find.WorldCameraDriver.JumpTo(target); // Camera-only reveal, like ui.reveal on a colony map.
            return target;
        }, ct);
        await RimBridge.Game.FramesAsync(2, ct);
        if (method == "world.reveal") return new { path = "ui-control", inputProcessed = true,
            commandAccepted = true, completion = "succeeded", tile = Identity(tile), evidence = "WorldCameraDriver.JumpTo" };
        var position = await RimBridgeMainThread.InvokeAsync(() => {
            Ready(true);
            var point = Find.WorldCamera.WorldToScreenPoint(Find.WorldGrid.GetTileCenter(tile));
            var screen = new Vector2(point.x / Prefs.UIScale, (Screen.height - point.y) / Prefs.UIScale);
            if (point.z <= 0 || screen.x < 0 || screen.x >= UI.screenWidth || screen.y < 0 || screen.y >= UI.screenHeight)
                throw new RpException("TARGET_NOT_VISIBLE", "World tile is outside the rendered viewport.");
            return screen;
        }, ct);
        var button = RpArgs.String(args, "button", "left");
        var options = new MapClickDispatchOptions {
            Button = button switch { "left" => 0, "right" => 1, _ => throw new RpException("INVALID_ARGUMENT", "Use left or right button.") },
            ButtonName = button, ScreenPositionInverted = position, Modifiers = RpMapInput.Modifiers(RpArgs.String(args, "modifiers"))
        };
        MapClickDispatchResult result;
        try {
            result = await Task.Run(() => RimBridgeMapClickInjector.DispatchClick(IntVec3.Invalid, "World tile " + tile.tileId, options), ct);
        } finally {
            await RimBridgeMainThread.InvokeAsync(() => { RimBridgeMapClickInjector.CancelPendingRequest(); return true; });
        }
        if (!result.Success) throw new RpException("UI_ACTION_FAILED", result.Message);
        await RimBridge.Game.NextFrameAsync(ct);
        return new { path = "ui-input", inputProcessed = true, commandAccepted = (bool?)null,
            completion = "not-checked", tile = Identity(tile), evidence = new { result.Message, screenX = position.x, screenY = position.y } };
    }
}
