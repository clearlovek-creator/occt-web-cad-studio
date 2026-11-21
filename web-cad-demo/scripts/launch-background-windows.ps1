$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $stage = 'request'
    $json = [Console]::In.ReadToEnd()
    if ($json.Length -gt 2097152) { throw 'Launch request exceeds budget' }
    $request = $json | ConvertFrom-Json
    foreach ($name in @('executable', 'cwd', 'stdout', 'stderr')) { if (-not [IO.Path]::IsPathRooted([string]$request.$name)) { throw 'Absolute launch paths are required' } }
    $stage = 'compile'
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CadRestrictedBackgroundV1 {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved; public string desktop; public string title;
        public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
        public short show, reservedCount; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);

    // The standard Windows argv quoting algorithm, including trailing slashes
    // and literal quotes. Arguments are data, never a PowerShell command string.
    public static string Quote(string value) {
        if (value == null) value = "";
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static SafeFileHandle Open(string name, bool input) {
        SecurityAttributes attributes = new SecurityAttributes(); attributes.length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.inherit = true;
        SafeFileHandle handle = CreateFileW(name, input ? 0x80000000u : 4u, 7u, ref attributes, input ? 3u : 4u, 0x80u, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        return handle;
    }
    public static uint Start(string executable, string cwd, string stdout, string stderr, string[] args, bool visible) {
        using (SafeFileHandle input = Open("NUL", true))
        using (SafeFileHandle output = Open(stdout, false))
        using (SafeFileHandle errors = Open(stderr, false)) {
            IntPtr size = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero; bool initialized = false;
            ProcessInfo process = new ProcessInfo();
            try {
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                initialized = true; handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handles, 0, input.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, IntPtr.Size, output.DangerousGetHandle());
                Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errors.DangerousGetHandle());
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                StartupInfoEx startup = new StartupInfoEx(); startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx)); startup.attributes = attributes;
                startup.info.flags = 0x101; startup.info.show = (short)(visible ? 5 : 0);
                startup.info.input = input.DangerousGetHandle(); startup.info.output = output.DangerousGetHandle(); startup.info.error = errors.DangerousGetHandle();
                StringBuilder command = new StringBuilder(Quote(executable)); foreach (string arg in args) command.Append(" ").Append(Quote(arg));
                // Hidden: DETACHED_PROCESS. Visible is explicit opt-in and gets
                // a new console. Neither inherits arbitrary caller pipe handles.
                uint flags = 0x80000u | 0x200u | (visible ? 0x10u : 8u);
                if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return process.pid;
            } finally {
                if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
                if (process.process != IntPtr.Zero) CloseHandle(process.process);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            }
        }
    }
}
'@
    $stage = 'spawn'
    $pidValue = [CadRestrictedBackgroundV1]::Start([string]$request.executable, [string]$request.cwd, [string]$request.stdout, [string]$request.stderr, [string[]]$request.args, [bool]$request.visible)
    [Console]::Out.WriteLine((@{pid=$pidValue;executable=[string]$request.executable} | ConvertTo-Json -Compress))
} catch {
    # Never echo the input environment, launch arguments or raw request.
    $nativeCode = if ($_.Exception.InnerException -is [ComponentModel.Win32Exception]) { $_.Exception.InnerException.NativeErrorCode } else { 0 }
    [Console]::Error.WriteLine(('WINDOWS_BACKGROUND_LAUNCH_FAILED stage=' + $stage + ' kind=' + $_.Exception.GetType().Name + ' code=' + $_.FullyQualifiedErrorId + ' native=' + $nativeCode))
    exit 1
}
