using System.IO;
using System.Linq;
using RimUIMCP.Core;
using Xunit;

namespace RimUIMCP.Core.Tests;

public sealed class SaveModCompatibilityTests
{
    [Fact]
    public void ReadsPackageIdsAndParallelDisplayNamesFromMetaHeader()
    {
        var metadata = Read("""
            <?xml version="1.0" encoding="utf-8"?>
            <savegame>
              <meta>
                <gameVersion>1.6.4850 rev652</gameVersion>
                <modIds>
                  <li>brrainz.harmony</li>
                  <li>brrainz.rimuimcp_steam</li>
                  <li>example.unnamed</li>
                </modIds>
                <modNames>
                  <li>Harmony</li>
                  <li>RimUIMCP &amp; Tools</li>
                </modNames>
              </meta>
              <game />
            </savegame>
            """);

        Assert.Equal(SaveModMetadataStatus.Readable, metadata.Status);
        Assert.Equal(3, metadata.Mods.Count);
        Assert.Equal("RimUIMCP & Tools", metadata.Mods[1].Name);
        Assert.Equal("brrainz.rimuimcp", metadata.Mods[1].CanonicalPackageId);
        Assert.Equal("example.unnamed", metadata.Mods[2].Name);
    }

    [Fact]
    public void StopsAfterMetaWithoutParsingMalformedGameData()
    {
        var metadata = Read("""
            <savegame>
              <meta>
                <modIds><li>ludeon.rimworld</li></modIds>
                <modNames><li>Core</li></modNames>
              </meta>
              <game><malformed>
            """);

        Assert.Equal(SaveModMetadataStatus.Readable, metadata.Status);
        Assert.Single(metadata.Mods);
    }

    [Fact]
    public void ProhibitsDocumentTypeDeclarations()
    {
        var metadata = Read("""
            <!DOCTYPE savegame [<!ENTITY mod "brrainz.harmony">]>
            <savegame>
              <meta>
                <modIds><li>&mod;</li></modIds>
              </meta>
            </savegame>
            """);

        Assert.Equal(SaveModMetadataStatus.Unreadable, metadata.Status);
        Assert.False(metadata.IsReadable);
    }

    [Fact]
    public void DistinguishesMissingMetadataFromUnreadableXml()
    {
        var missing = Read("<savegame><game /></savegame>");
        var unreadable = Read("<savegame><meta>");

        Assert.Equal(SaveModMetadataStatus.MissingModMetadata, missing.Status);
        Assert.Equal(SaveModMetadataStatus.Unreadable, unreadable.Status);
    }

    [Theory]
    [InlineData(" brrainz.rimuimcp_STEAM ", "brrainz.rimuimcp")]
    [InlineData("Dubwise.DubsPerformanceAnalyzer.steam", "dubwise.dubsperformanceanalyzer.steam")]
    [InlineData("example_steam.extension", "example_steam.extension")]
    [InlineData("example_steam_steam", "example_steam")]
    public void CanonicalizesOnlyOneExactTrailingSteamPostfix(string packageId, string expected)
    {
        Assert.Equal(expected, SaveModCompatibility.CanonicalizePackageId(packageId));
    }

    [Fact]
    public void TreatsSavedModsAsSubsetAndSteamAndOfflineCopiesAsEqual()
    {
        var savedSteam = ReadMetadata("brrainz.harmony", "brrainz.rimuimcp_steam");
        var savedOffline = ReadMetadata("brrainz.harmony", "brrainz.rimuimcp");

        var steamAgainstOffline = SaveModCompatibility.Evaluate(
            savedSteam,
            ["ludeon.rimworld", "brrainz.rimuimcp", "brrainz.harmony", "extra.current.mod"]);
        var offlineAgainstSteam = SaveModCompatibility.Evaluate(
            savedOffline,
            ["brrainz.rimuimcp_steam", "brrainz.harmony"]);

        Assert.Equal(SaveModCompatibilityStatus.Compatible, steamAgainstOffline.Status);
        Assert.True(steamAgainstOffline.IsCompatible);
        Assert.Equal(SaveModCompatibilityStatus.Compatible, offlineAgainstSteam.Status);
        Assert.True(offlineAgainstSteam.IsCompatible);
    }

    [Fact]
    public void PreservesSavedOrderAndIdentityForMissingMods()
    {
        var metadata = Read("""
            <savegame>
              <meta>
                <modIds>
                  <li>present.mod</li>
                  <li>first.missing_steam</li>
                  <li>second.missing</li>
                </modIds>
                <modNames>
                  <li>Present</li>
                  <li>First Missing</li>
                  <li>Second Missing</li>
                </modNames>
              </meta>
            </savegame>
            """);

        var compatibility = SaveModCompatibility.Evaluate(metadata, ["present.mod"]);

        Assert.Equal(SaveModCompatibilityStatus.MissingMods, compatibility.Status);
        Assert.False(compatibility.IsCompatible);
        Assert.Equal(
            ["first.missing_steam", "second.missing"],
            compatibility.MissingMods.Select(mod => mod.PackageId).ToArray());
        Assert.Equal(
            ["First Missing", "Second Missing"],
            compatibility.MissingMods.Select(mod => mod.Name).ToArray());
    }

    [Fact]
    public void RepresentsUnavailableMetadataWithoutCallingItCompatible()
    {
        var metadata = Read("<savegame><game /></savegame>");

        var compatibility = SaveModCompatibility.Evaluate(metadata, ["ludeon.rimworld"]);

        Assert.Equal(SaveModCompatibilityStatus.MetadataUnavailable, compatibility.Status);
        Assert.Equal(SaveModMetadataStatus.MissingModMetadata, compatibility.MetadataStatus);
        Assert.False(compatibility.MetadataReadable);
        Assert.False(compatibility.IsCompatible);
        Assert.NotEmpty(compatibility.MetadataError);
        Assert.Empty(compatibility.MissingMods);
    }

    private static SaveModMetadataReadResult Read(string xml)
    {
        return SaveModCompatibility.ReadMetadata(new StringReader(xml));
    }

    private static SaveModMetadataReadResult ReadMetadata(params string[] packageIds)
    {
        var items = string.Join(string.Empty, packageIds.Select(packageId => $"<li>{packageId}</li>"));
        return Read($"<savegame><meta><modIds>{items}</modIds></meta></savegame>");
    }
}
