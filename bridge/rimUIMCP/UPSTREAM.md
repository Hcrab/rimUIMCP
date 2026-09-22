# Upstream baseline

Source: https://github.com/pardeike/RimBridgeServer
Commit: ca5997c9e02f53609358223a673834e35a1d1ee1 (2.1.1).
Imported via git archive. MIT license retained. The rimUIMCP implementation lives in `Source/RimUIMCP`.
Game binaries and local decompiled inspection material are not distributed.

Integration edits:

- `RimBridgeStartup`: register the `rimuimcp/call` surface in every session; original native/debug tools and extension aliases are registered only in explicit fixture mode. Remove automatic ultra-speed boosting.
- `RimBridgeUiWorkbench`: semantic metadata, live control fingerprints, window/scroll coordinate handling, real MouseDown/MouseUp control interaction, form and scroll requests, button/modifier propagation, request cancellation and bounded retained captures.
- `RimBridgeVirtualPointer`: retain the UI pointer after a click, allowing normal floating menus to remain visible; real human input clears the virtual pointer.
- `RimBridgeMapClickInjector`: cancellation cleanup and optional current DrawPos for selecting a moving pawn.
- `RimWorldState.DescribePawn`: guard selection lookup before entering the playing UI, so starting-candidate observations do not cast the entry UI to UIRoot_Play.
- `Source/RimUIMCP/Adapters`: main menu/buttons, work and schedule cells, text fields, sliders, research, bills/trade, item filters, map/keyboard input and letters. Original UI handlers perform gameplay changes.
- `Source/RimUIMCP`: read-only field/query traversal, session/reference identity, shared action surface, serialized GUI sequences, events, journal, runtime control and explicitly marked fixture setup.

The upstream MIT license and notices remain in place. No game assembly, publicized game binary or locally decompiled source is part of the intended source deliverable. Current compatibility was exercised against local RimWorld 1.6.4871; other game versions and arbitrary third-party UI mods are not implied to work.
