using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace RimUIMCP.Core;

public enum SaveModMetadataStatus
{
    Readable,
    MissingModMetadata,
    Unreadable
}

public enum SaveModCompatibilityStatus
{
    Compatible,
    MissingMods,
    MetadataUnavailable
}

public sealed class SaveModReference
{
    public SaveModReference(string packageId, string name)
    {
        PackageId = packageId?.Trim() ?? string.Empty;
        CanonicalPackageId = SaveModCompatibility.CanonicalizePackageId(PackageId);
        Name = string.IsNullOrWhiteSpace(name) ? PackageId : name.Trim();
    }

    public string PackageId { get; }

    public string CanonicalPackageId { get; }

    public string Name { get; }
}

public sealed class SaveModMetadataReadResult
{
    internal SaveModMetadataReadResult(
        SaveModMetadataStatus status,
        IReadOnlyList<SaveModReference> mods,
        string error)
    {
        Status = status;
        Mods = mods ?? Array.Empty<SaveModReference>();
        Error = error ?? string.Empty;
    }

    public SaveModMetadataStatus Status { get; }

    public bool IsReadable => Status == SaveModMetadataStatus.Readable;

    public IReadOnlyList<SaveModReference> Mods { get; }

    public string Error { get; }
}

public sealed class SaveModCompatibilityResult
{
    internal SaveModCompatibilityResult(
        SaveModCompatibilityStatus status,
        SaveModMetadataStatus metadataStatus,
        IReadOnlyList<SaveModReference> missingMods,
        string metadataError)
    {
        Status = status;
        MetadataStatus = metadataStatus;
        MissingMods = missingMods ?? Array.Empty<SaveModReference>();
        MetadataError = metadataError ?? string.Empty;
    }

    public SaveModCompatibilityStatus Status { get; }

    public SaveModMetadataStatus MetadataStatus { get; }

    public bool MetadataReadable => MetadataStatus == SaveModMetadataStatus.Readable;

    public bool IsCompatible => Status == SaveModCompatibilityStatus.Compatible;

    public IReadOnlyList<SaveModReference> MissingMods { get; }

    public string MetadataError { get; }
}

public static class SaveModCompatibility
{
    public const string SteamPostfix = "_steam";

    public static SaveModMetadataReadResult ReadMetadata(string savePath)
    {
        if (string.IsNullOrWhiteSpace(savePath))
            return Unreadable("A save path is required.");

        try
        {
            using var stream = File.OpenRead(savePath);
            using var textReader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true);
            return ReadMetadata(textReader);
        }
        catch (Exception ex)
        {
            return Unreadable(ex.GetBaseException().Message);
        }
    }

    public static SaveModMetadataReadResult ReadMetadata(TextReader textReader)
    {
        if (textReader == null)
            return Unreadable("A save reader is required.");

        try
        {
            var settings = new XmlReaderSettings
            {
                CloseInput = false,
                DtdProcessing = DtdProcessing.Prohibit,
                IgnoreComments = true,
                IgnoreProcessingInstructions = true,
                IgnoreWhitespace = true,
                XmlResolver = null
            };

            using var reader = XmlReader.Create(textReader, settings);
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element
                    || string.Equals(reader.LocalName, "meta", StringComparison.Ordinal) == false)
                {
                    continue;
                }

                using var metaReader = reader.ReadSubtree();
                var meta = XElement.Load(metaReader, LoadOptions.None);
                return ParseMetaElement(meta);
            }

            return MissingMetadata("The save does not contain a <meta> element.");
        }
        catch (Exception ex)
        {
            return Unreadable(ex.GetBaseException().Message);
        }
    }

    public static string CanonicalizePackageId(string packageId)
    {
        var normalized = packageId?.Trim() ?? string.Empty;
        if (normalized.EndsWith(SteamPostfix, StringComparison.OrdinalIgnoreCase))
            normalized = normalized.Substring(0, normalized.Length - SteamPostfix.Length);

        return normalized.ToLowerInvariant();
    }

    public static SaveModCompatibilityResult Evaluate(
        SaveModMetadataReadResult metadata,
        IEnumerable<string> activePackageIds)
    {
        if (metadata == null)
            throw new ArgumentNullException(nameof(metadata));

        if (metadata.IsReadable == false)
        {
            return new SaveModCompatibilityResult(
                SaveModCompatibilityStatus.MetadataUnavailable,
                metadata.Status,
                Array.Empty<SaveModReference>(),
                metadata.Error);
        }

        var activeIds = new HashSet<string>(
            (activePackageIds ?? Array.Empty<string>())
                .Select(CanonicalizePackageId)
                .Where(packageId => packageId.Length > 0),
            StringComparer.Ordinal);
        var missingMods = metadata.Mods
            .Where(mod => activeIds.Contains(mod.CanonicalPackageId) == false)
            .ToList();

        return new SaveModCompatibilityResult(
            missingMods.Count == 0
                ? SaveModCompatibilityStatus.Compatible
                : SaveModCompatibilityStatus.MissingMods,
            metadata.Status,
            missingMods,
            string.Empty);
    }

    private static SaveModMetadataReadResult ParseMetaElement(XElement meta)
    {
        var modIdsElement = meta.Elements()
            .FirstOrDefault(element => string.Equals(element.Name.LocalName, "modIds", StringComparison.Ordinal));
        if (modIdsElement == null)
            return MissingMetadata("The save <meta> element does not contain <modIds>.");

        var modIds = ReadList(modIdsElement);
        var modNamesElement = meta.Elements()
            .FirstOrDefault(element => string.Equals(element.Name.LocalName, "modNames", StringComparison.Ordinal));
        var modNames = modNamesElement == null ? [] : ReadList(modNamesElement);
        var mods = new List<SaveModReference>(modIds.Count);

        for (var index = 0; index < modIds.Count; index++)
        {
            var packageId = modIds[index]?.Trim() ?? string.Empty;
            if (packageId.Length == 0)
                continue;

            var name = index < modNames.Count ? modNames[index] : packageId;
            mods.Add(new SaveModReference(packageId, name));
        }

        return new SaveModMetadataReadResult(
            SaveModMetadataStatus.Readable,
            mods,
            string.Empty);
    }

    private static List<string> ReadList(XElement parent)
    {
        return parent.Elements()
            .Where(element => string.Equals(element.Name.LocalName, "li", StringComparison.Ordinal))
            .Select(element => element.Value)
            .ToList();
    }

    private static SaveModMetadataReadResult MissingMetadata(string error)
    {
        return new SaveModMetadataReadResult(
            SaveModMetadataStatus.MissingModMetadata,
            Array.Empty<SaveModReference>(),
            error);
    }

    private static SaveModMetadataReadResult Unreadable(string error)
    {
        return new SaveModMetadataReadResult(
            SaveModMetadataStatus.Unreadable,
            Array.Empty<SaveModReference>(),
            error);
    }
}
