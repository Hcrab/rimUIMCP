# Third-party notices

rimUIMCP contains and depends on software written by other authors. The
rimUIMCP MIT license applies only to material for which the rimUIMCP copyright
holder has the right to grant that license. Third-party material remains under
its own license.

## RimBridgeServer

The in-game bridge under `bridge/rimUIMCP` is derived from
[RimBridgeServer](https://github.com/pardeike/RimBridgeServer), baseline commit
`ca5997c9e02f53609358223a673834e35a1d1ee1` (version 2.1.1).

Copyright (c) 2025 Andreas Pardeike.

RimBridgeServer is licensed under the MIT License. The original copyright and
permission notice are retained in `bridge/rimUIMCP/LICENSE`. The fork
history and the principal integration changes are recorded in
`bridge/rimUIMCP/UPSTREAM.md`.

The original RimBridgeServer icon and preview image remain upstream material
and are not claimed as original rimUIMCP artwork. Included artwork retains
the upstream MIT notice. Editable artwork sources and packaged release copies
are not included in this source export; they remain available upstream.

## RimWorld and Ludeon Studios

RimWorld, its code, assets, names, and related rights belong to Ludeon Studios
Inc. rimUIMCP does not distribute RimWorld, an expansion, a game assembly, or
locally decompiled game source. `Krafs.Rimworld.Ref` is used at build time as a
code-stripped reference assembly published with permission from Ludeon.

Portions of the materials used to create this content/mod are trademarks and/or copyrighted works of Ludeon Studios Inc. All rights reserved by Ludeon. This content/mod is not official and is not endorsed by Ludeon.

Use of rimUIMCP requires a full, registered copy of RimWorld and remains
subject to the RimWorld EULA:
https://store.steampowered.com/eula/294100_eula_1

## Direct software dependencies

The source tree references packages including Lib.GAB, Harmony,
Newtonsoft.Json, the Model Context Protocol TypeScript SDK, Zod, TypeScript,
and the Node.js type definitions. Their authors retain their respective
copyrights. Package versions and transitive dependencies are recorded in the
NuGet project files and `pnpm-lock.yaml`; their MIT, Apache-2.0, or other
package-specific licenses continue to apply.
