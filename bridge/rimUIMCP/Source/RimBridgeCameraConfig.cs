using System;
using UnityEngine;
using Verse;

namespace RimUIMCP;

internal static class RimBridgeCameraConfig
{
    internal sealed class ZoomExtensionChange
    {
        public ZoomExtensionChange(
            bool changed,
            bool previousEnabled,
            bool enabled,
            FloatRange previousSizeRange,
            FloatRange sizeRange,
            float rootSize,
            bool rootSizeClamped)
        {
            Changed = changed;
            PreviousEnabled = previousEnabled;
            Enabled = enabled;
            PreviousSizeRange = previousSizeRange;
            SizeRange = sizeRange;
            RootSize = rootSize;
            RootSizeClamped = rootSizeClamped;
        }

        public bool Changed { get; }

        public bool PreviousEnabled { get; }

        public bool Enabled { get; }

        public FloatRange PreviousSizeRange { get; }

        public FloatRange SizeRange { get; }

        public float RootSize { get; }

        public bool RootSizeClamped { get; }
    }

    private const float MinimumExtendedZoom = 0f;
    private const float MaximumExtendedZoom = 100f;

    private static readonly FloatRange ExtendedZoomRange = new(MinimumExtendedZoom, MaximumExtendedZoom);
    private static CameraMapConfig _capturedConfig;
    private static FloatRange _capturedSizeRange;
    private static bool _hasCapturedSizeRange;
    private static bool _enabled;
    private static bool _loggedApplied;
    private static bool _loggedFailure;

    public static bool CameraZoomExtensionEnabled => _enabled;

    public static ZoomExtensionChange SetZoomExtension(bool enabled)
    {
        var driver = Find.CameraDriver ?? throw new InvalidOperationException("No map camera is available.");
        var config = driver.config ?? throw new InvalidOperationException("The map camera has no active configuration.");
        var previousEnabled = _enabled;

        if (_enabled)
            EnsureCurrentConfigExtended(config);

        var previousSizeRange = config.sizeRange;
        var changed = previousEnabled != enabled;
        var rootSizeClamped = false;

        if (changed && enabled)
        {
            CaptureAndExtend(config);
            _enabled = true;
            LogExtensionApplied();
        }
        else if (changed)
        {
            RestoreCapturedConfig();
            ClearCapturedConfig();
            _enabled = false;

            var clampedRootSize = Mathf.Clamp(driver.RootSize, config.sizeRange.min, config.sizeRange.max);
            rootSizeClamped = Mathf.Approximately(clampedRootSize, driver.RootSize) == false;
            if (rootSizeClamped)
                driver.SetRootSize(clampedRootSize);
        }

        return new ZoomExtensionChange(
            changed,
            previousEnabled,
            _enabled,
            previousSizeRange,
            config.sizeRange,
            driver.RootSize,
            rootSizeClamped);
    }

    public static void MaintainZoomExtension()
    {
        if (_enabled == false)
            return;

        try
        {
            var config = Find.CameraDriver?.config;
            if (config == null)
                return;

            EnsureCurrentConfigExtended(config);
        }
        catch (Exception ex)
        {
            if (_loggedFailure)
                return;

            _loggedFailure = true;
            Log.Warning($"[RimBridge] Could not maintain the camera zoom extension: {ex}");
        }
    }

    private static void EnsureCurrentConfigExtended(CameraMapConfig config)
    {
        if (ReferenceEquals(_capturedConfig, config) == false)
            CaptureAndExtend(config);
        else if (IsExtendedZoomRange(config.sizeRange) == false)
            config.sizeRange = ExtendedZoomRange;
    }

    private static void CaptureAndExtend(CameraMapConfig config)
    {
        RestoreCapturedConfig();
        _capturedConfig = config;
        _capturedSizeRange = config.sizeRange;
        _hasCapturedSizeRange = true;
        config.sizeRange = ExtendedZoomRange;
    }

    private static void RestoreCapturedConfig()
    {
        if (_capturedConfig != null && _hasCapturedSizeRange)
            _capturedConfig.sizeRange = _capturedSizeRange;
    }

    private static void ClearCapturedConfig()
    {
        _capturedConfig = null;
        _capturedSizeRange = default;
        _hasCapturedSizeRange = false;
    }

    private static void LogExtensionApplied()
    {
        if (_loggedApplied)
            return;

        _loggedApplied = true;
        Log.Message("[RimBridge] Camera zoom extension enabled for this session (0..100).");
    }

    private static bool IsExtendedZoomRange(FloatRange range)
    {
        return Mathf.Approximately(range.min, MinimumExtendedZoom)
            && Mathf.Approximately(range.max, MaximumExtendedZoom);
    }
}
