param(
    [Parameter(Mandatory = $true)]
    [string]$Shortcut,
    [Parameter(Mandatory = $true)]
    [string]$AppId
)

# Win32 ToastNotificationManager resolves the application identity from the
# Start Menu shortcut's System.AppUserModel.ID property. WScript.Shell can
# create the .lnk but cannot write that property, so use the documented Shell
# property-store COM interface from the installer.
Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
    public PROPERTYKEY(Guid formatId, uint propertyId) {
        fmtid = formatId;
        pid = propertyId;
    }
}

[StructLayout(LayoutKind.Explicit, Size = 16)]
public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;

    public static PROPVARIANT FromString(string value) {
        var result = new PROPVARIANT();
        result.vt = 31; // VT_LPWSTR
        result.pointerValue = Marshal.StringToCoTaskMemUni(value);
        return result;
    }

    public void Dispose() {
        if (pointerValue != IntPtr.Zero) {
            Marshal.FreeCoTaskMem(pointerValue);
            pointerValue = IntPtr.Zero;
        }
    }
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
}

public static class ShortcutPropertyStore {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    public static extern int SHGetPropertyStoreFromParsingName(
        string path,
        IntPtr pbc,
        uint flags,
        ref Guid riid,
        out IPropertyStore store);

    public static void SetAppId(string path, string appId) {
        var iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        var hr = SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        var key = new PROPERTYKEY(
            new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            5); // PKEY_AppUserModel_ID
        var value = PROPVARIANT.FromString(appId);
        try {
            hr = store.SetValue(ref key, ref value);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            hr = store.Commit();
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        } finally {
            value.Dispose();
            Marshal.ReleaseComObject(store);
        }
    }
}
"@

[ShortcutPropertyStore]::SetAppId((Resolve-Path -LiteralPath $Shortcut).Path, $AppId)
