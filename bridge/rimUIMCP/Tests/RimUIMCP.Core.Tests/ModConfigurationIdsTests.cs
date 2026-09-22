using RimUIMCP.Core;
using Xunit;

namespace RimUIMCP.Core.Tests;

public class ModConfigurationIdsTests
{
    [Fact]
    public void CreatesStableIdFromPackageIdAndRootDir()
    {
        var first = ModConfigurationIds.CreateId("brrainz.rimuimcp", "/tmp/RimUIMCP");
        var second = ModConfigurationIds.CreateId("brrainz.rimuimcp", "/tmp/RimUIMCP");

        Assert.Equal(first, second);
        Assert.StartsWith("mod-config:brrainz.rimuimcp:", first);
    }
}
