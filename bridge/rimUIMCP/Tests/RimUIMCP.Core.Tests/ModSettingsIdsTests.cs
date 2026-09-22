using RimUIMCP.Core;
using Xunit;

namespace RimUIMCP.Core.Tests;

public class ModSettingsIdsTests
{
    [Fact]
    public void CreatesStableIdFromPackageIdAndHandleType()
    {
        var first = ModSettingsIds.CreateId("brrainz.rimuimcp", "RimUIMCP.RimUIMCPMod");
        var second = ModSettingsIds.CreateId("brrainz.rimuimcp", "RimUIMCP.RimUIMCPMod");

        Assert.Equal(first, second);
        Assert.StartsWith("mod-settings:brrainz.rimuimcp:", first);
    }
}
