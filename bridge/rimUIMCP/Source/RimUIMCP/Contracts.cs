using System;
using Newtonsoft.Json.Linq;

namespace RimUIMCP;

// Shared wire shapes. Keep the bridge boring so the agent can be creative.
public sealed class RpException : Exception
{
    public string Code { get; }
    public object Details { get; }
    public RpException(string code, string message, object details = null) : base(message)
    { Code = code; Details = details; }
}

public sealed class ObjectRef
{
    public string id;
    public string sessionId;
    public int worldEpoch;
    public string type;
}

internal static class RpArgs
{
    public static string String(JObject args, string key, string fallback = null) => args?[key]?.Type == JTokenType.Null ? fallback : args?[key]?.Value<string>() ?? fallback;
    public static int Int(JObject args, string key, int fallback = 0) => args?[key]?.Value<int?>() ?? fallback;
    public static bool Bool(JObject args, string key, bool fallback = false) => args?[key]?.Value<bool?>() ?? fallback;
}
