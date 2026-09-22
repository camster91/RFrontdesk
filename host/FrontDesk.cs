// Rotman Front Desk — Windows host.
//
// A real window (no browser chrome) wrapping the existing web app, with the
// data moved out of Edge's profile and into a folder the operator owns.
//
// Compiled with the in-box .NET Framework compiler, so this file must stay
// C# 5: no string interpolation, no null-conditional operator, no
// expression-bodied members, no auto-property initializers. That is a
// deliberate trade -- it means the project builds on any Windows box with no
// SDK, no NuGet restore, and nothing to install.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace FrontDeskHost
{
    internal static class Build
    {
        public const string Version = "1.0.0";
        public const int KeepBackups = 30;
        // A stable, per-user virtual host. Serving the app over a real https
        // origin is what lets IndexedDB work; file:// would give an opaque
        // origin with no storage at all.
        public const string VirtualHost = "frontdesk.local";
    }

    /// <summary>
    /// Where everything lives. The app folder is preferred so the whole thing
    /// stays portable, but a copy dropped somewhere unwritable (Program Files,
    /// a read-only share) falls back to LocalAppData rather than dying on
    /// first launch.
    /// </summary>
    internal static class Paths
    {
        public static string Root;
        public static string Web;
        public static string Data;
        public static string Backups;
        public static string BrowserData;
        public static string LogFile;
        public static bool Portable;

        public static void Resolve()
        {
            Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            Web = Path.Combine(Root, "web");
            string preferred = Path.Combine(Root, "data");
            if (IsWritable(preferred))
            {
                Data = preferred;
                Portable = true;
            }
            else
            {
                Data = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "FrontDesk", "data");
                Portable = false;
            }
            Backups = Path.Combine(Data, "backups");
            BrowserData = Path.Combine(Data, "browser");
            LogFile = Path.Combine(Data, "frontdesk.log");
            SafeCreate(Data);
            SafeCreate(Backups);
        }

        private static void SafeCreate(string dir)
        {
            try { Directory.CreateDirectory(dir); }
            catch { }
        }

        private static bool IsWritable(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".write-probe");
                File.WriteAllText(probe, "1");
                File.Delete(probe);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static void Log(string message)
        {
            try
            {
                string line = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0:yyyy-MM-dd HH:mm:ss}  {1}{2}",
                    DateTime.Now, message, Environment.NewLine);
                File.AppendAllText(LogFile, line);
            }
            catch
            {
            }
        }
    }

    internal static class Json
    {
        public static string Escape(string s)
        {
            if (s == null) return "";
            StringBuilder b = new StringBuilder(s.Length + 8);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < ' ' || c > '~')
                            b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            b.Append(c);
                        break;
                }
            }
            return b.ToString();
        }

        public static string Str(string s)
        {
            return "\"" + Escape(s) + "\"";
        }

        public static string Bool(bool v)
        {
            return v ? "true" : "false";
        }
    }

    /// <summary>
    /// The object the page sees as <c>chrome.webview.hostObjects.frontDeskHost</c>.
    ///
    /// Every method returns a JSON string rather than a marshalled object:
    /// host-object calls cross a COM boundary, and handing back a plain string
    /// keeps the contract obvious on both sides and impossible to get subtly
    /// wrong. Methods never throw across the boundary -- a failure comes back
    /// as {"ok":false,"error":"..."} so the page can show it instead of
    /// rejecting an unhandled promise.
    /// </summary>
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class Bridge
    {
        private readonly MainForm _form;

        public Bridge(MainForm form)
        {
            _form = form;
        }

        /// <summary>Version and every path the UI needs to show the operator.</summary>
        public string GetInfo()
        {
            try
            {
                StringBuilder b = new StringBuilder();
                b.Append("{");
                b.Append("\"ok\":true,");
                b.Append("\"version\":").Append(Json.Str(Build.Version)).Append(",");
                b.Append("\"hosted\":true,");
                b.Append("\"portable\":").Append(Json.Bool(Paths.Portable)).Append(",");
                b.Append("\"root\":").Append(Json.Str(Paths.Root)).Append(",");
                b.Append("\"dataDir\":").Append(Json.Str(Paths.Data)).Append(",");
                b.Append("\"backupDir\":").Append(Json.Str(Paths.Backups)).Append(",");
                b.Append("\"logFile\":").Append(Json.Str(Paths.LogFile)).Append(",");
                b.Append("\"keepBackups\":").Append(Build.KeepBackups.ToString(CultureInfo.InvariantCulture)).Append(",");
                b.Append("\"autostart\":").Append(Json.Bool(Autostart.IsEnabled())).Append(",");
                // What the startup entry will run, so the Settings screen can say
                // it rather than leaving the operator to guess. DevTools off is
                // part of it and used to be dropped on the floor here.
                b.Append("\"autostartArgs\":").Append(Json.Str(Autostart.Args())).Append(",");
                b.Append("\"runtime\":").Append(Json.Str(MainForm.RuntimeVersion ?? ""));
                b.Append("}");
                return b.ToString();
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>
        /// Write a backup into the backups folder, verify it landed intact, and
        /// rotate out the oldest beyond the retention limit.
        ///
        /// Verification is a read-back, not a trust-the-write: a backup that
        /// silently truncated is worse than no backup, because it is the one
        /// you find out about when you need it.
        /// </summary>
        public string SaveBackup(string json, string suggestedName)
        {
            try
            {
                if (json == null || json.Length == 0)
                    return Fail("Nothing to write — the backup was empty.");

                string name = Sanitize(suggestedName);
                if (name.Length == 0)
                    name = "frontdesk-backup-" + DateTime.Now.ToString("yyyy-MM-dd-HHmmss", CultureInfo.InvariantCulture) + ".json";
                if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) name += ".json";

                string path = Path.Combine(Paths.Backups, name);
                File.WriteAllText(path, json, new UTF8Encoding(false));

                // Read it back and confirm it is the same length and still looks
                // like the export it claims to be.
                string verify = File.ReadAllText(path);
                long bytes = verify.Length;
                bool sizeOk = bytes == json.Length;
                bool shapeOk = verify.TrimStart().StartsWith("{", StringComparison.Ordinal) &&
                               verify.IndexOf("\"items\"", StringComparison.Ordinal) >= 0;

                List<string> removed = Rotate();

                StringBuilder b = new StringBuilder();
                b.Append("{");
                b.Append("\"ok\":").Append(Json.Bool(sizeOk && shapeOk)).Append(",");
                b.Append("\"path\":").Append(Json.Str(path)).Append(",");
                b.Append("\"file\":").Append(Json.Str(Path.GetFileName(path))).Append(",");
                b.Append("\"bytes\":").Append(bytes.ToString(CultureInfo.InvariantCulture)).Append(",");
                b.Append("\"verified\":").Append(Json.Bool(sizeOk && shapeOk)).Append(",");
                b.Append("\"sizeMatches\":").Append(Json.Bool(sizeOk)).Append(",");
                b.Append("\"looksLikeExport\":").Append(Json.Bool(shapeOk)).Append(",");
                b.Append("\"rotatedOut\":").Append(removed.Count.ToString(CultureInfo.InvariantCulture)).Append(",");
                b.Append("\"kept\":").Append(List().Count.ToString(CultureInfo.InvariantCulture));
                if (!(sizeOk && shapeOk))
                    b.Append(",\"error\":").Append(Json.Str("The file on disk does not match what was written."));
                b.Append("}");
                Paths.Log("backup written: " + path + " (" + bytes + " bytes, verified=" + (sizeOk && shapeOk) + ")");
                return b.ToString();
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>Newest first, for the restore list.</summary>
        public string ListBackups()
        {
            try
            {
                List<FileInfo> files = List();
                StringBuilder b = new StringBuilder();
                b.Append("{\"ok\":true,\"backups\":[");
                for (int i = 0; i < files.Count; i++)
                {
                    if (i > 0) b.Append(",");
                    b.Append("{");
                    b.Append("\"file\":").Append(Json.Str(files[i].Name)).Append(",");
                    b.Append("\"bytes\":").Append(files[i].Length.ToString(CultureInfo.InvariantCulture)).Append(",");
                    b.Append("\"modified\":").Append(files[i].LastWriteTimeUtc.Subtract(
                        new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds
                        .ToString("0", CultureInfo.InvariantCulture));
                    b.Append("}");
                }
                b.Append("],\"dir\":").Append(Json.Str(Paths.Backups));
                b.Append(",\"keepBackups\":").Append(Build.KeepBackups.ToString(CultureInfo.InvariantCulture));
                b.Append("}");
                return b.ToString();
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>Contents of one backup, for the restore flow.</summary>
        public string ReadBackup(string fileName)
        {
            try
            {
                string safe = Path.GetFileName(fileName == null ? "" : fileName);
                if (safe.Length == 0) return Fail("No backup was named.");
                string path = Path.Combine(Paths.Backups, safe);
                if (!File.Exists(path)) return Fail("That backup is no longer in the folder.");

                string text = File.ReadAllText(path);
                StringBuilder b = new StringBuilder();
                b.Append("{\"ok\":true,\"file\":").Append(Json.Str(safe));
                b.Append(",\"bytes\":").Append(text.Length.ToString(CultureInfo.InvariantCulture));
                b.Append(",\"text\":").Append(Json.Str(text));
                b.Append("}");
                return b.ToString();
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>
        /// "Export a copy" -- asks where to put it with a real Windows Save
        /// dialog, defaulting to the backups folder. Returns {"ok":true,
        /// "cancelled":true} when the operator backs out, which is not an error.
        /// </summary>
        public string ExportCopy(string json, string suggestedName)
        {
            try
            {
                string chosen = _form.AskSavePath(Sanitize(suggestedName));
                if (chosen == null) return "{\"ok\":true,\"cancelled\":true}";
                File.WriteAllText(chosen, json, new UTF8Encoding(false));
                Paths.Log("exported a copy to " + chosen);
                return "{\"ok\":true,\"cancelled\":false,\"path\":" + Json.Str(chosen) + "}";
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>Pick a backup file from anywhere on disk and hand back its text.</summary>
        public string ImportFromDialog()
        {
            try
            {
                string chosen = _form.AskOpenPath();
                if (chosen == null) return "{\"ok\":true,\"cancelled\":true}";
                string text = File.ReadAllText(chosen);
                StringBuilder b = new StringBuilder();
                b.Append("{\"ok\":true,\"cancelled\":false,\"path\":").Append(Json.Str(chosen));
                b.Append(",\"text\":").Append(Json.Str(text));
                b.Append("}");
                return b.ToString();
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        public string OpenFolder(string which)
        {
            try
            {
                string dir = string.Equals(which, "backups", StringComparison.OrdinalIgnoreCase)
                    ? Paths.Backups
                    : Paths.Data;
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
                return "{\"ok\":true}";
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        public string ReadLog()
        {
            try
            {
                if (!File.Exists(Paths.LogFile)) return "{\"ok\":true,\"text\":\"\"}";
                string text = File.ReadAllText(Paths.LogFile);
                // Only the tail -- the log is append-only and could be long.
                if (text.Length > 20000) text = text.Substring(text.Length - 20000);
                return "{\"ok\":true,\"text\":" + Json.Str(text) + "}";
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        public string GetAutostart()
        {
            try
            {
                return "{\"ok\":true,\"enabled\":" + Json.Bool(Autostart.IsEnabled()) + "}";
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        public string SetAutostart(bool enabled)
        {
            try
            {
                Autostart.Set(enabled);
                return "{\"ok\":true,\"enabled\":" + Json.Bool(Autostart.IsEnabled()) + "}";
            }
            catch (Exception ex)
            {
                return Error(ex);
            }
        }

        /// <summary>The page reports its own errors here, so they land next to the host's.</summary>
        public string LogClientError(string message)
        {
            Paths.Log("client: " + message);
            return "{\"ok\":true}";
        }

        /// <summary>Open the window back up from the tray.</summary>
        public string ShowWindow()
        {
            _form.ShowFromTray();
            return "{\"ok\":true}";
        }

        private static string Sanitize(string name)
        {
            if (name == null) return "";
            StringBuilder b = new StringBuilder();
            foreach (char c in name)
            {
                if (char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.' || c == ' ')
                    b.Append(c);
            }
            return b.ToString().Trim();
        }

        private static List<FileInfo> List()
        {
            List<FileInfo> files = new List<FileInfo>();
            try
            {
                DirectoryInfo dir = new DirectoryInfo(Paths.Backups);
                if (!dir.Exists) return files;
                foreach (FileInfo f in dir.GetFiles("*.json"))
                    files.Add(f);
            }
            catch
            {
            }
            files.Sort(delegate(FileInfo a, FileInfo b)
            {
                return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc);
            });
            return files;
        }

        /// <summary>Keep the newest N, delete the rest. Returns what went.</summary>
        private static List<string> Rotate()
        {
            List<string> gone = new List<string>();
            List<FileInfo> files = List();
            for (int i = Build.KeepBackups; i < files.Count; i++)
            {
                try
                {
                    files[i].Delete();
                    gone.Add(files[i].Name);
                }
                catch
                {
                }
            }
            return gone;
        }

        private static string Fail(string message)
        {
            return "{\"ok\":false,\"error\":" + Json.Str(message) + "}";
        }

        private static string Error(Exception ex)
        {
            Paths.Log("bridge error: " + ex);
            return "{\"ok\":false,\"error\":" + Json.Str(ex.Message) + "}";
        }
    }

    /// <summary>
    /// The command line, parsed once and rendered back to a string.
    ///
    /// This exists because the autostart entry has to reproduce the way the app
    /// was *started*, not merely the fact of it. DevTools are on by default and
    /// --no-devtools at launch is the only way to turn them off, so a Run value
    /// that hard-coded "--minimized" quietly undid a kiosk lockdown: the tablet
    /// rebooted, Windows started the app from the Run key, and DevTools -- which
    /// on the kiosk screen are a way around its PIN -- were back, with nothing
    /// said. Whatever flags this process is running under are the flags the next
    /// logon gets.
    /// </summary>
    public sealed class StartupOptions
    {
        public bool Minimized;
        public bool DevTools = true;

        /// <summary>
        /// How this process was started. Read from the real command line rather
        /// than threaded through the app, so that the two places which can switch
        /// autostart on -- the tray menu and the page's own Settings toggle --
        /// cannot disagree about what to write.
        /// </summary>
        public static readonly StartupOptions Current = Parse(FromCommandLine(Environment.GetCommandLineArgs()));

        /// <summary>
        /// The command line with the program name dropped.
        ///
        /// The two ways to reach a process's arguments differ in exactly this:
        /// Main's <c>args</c> have already had the program name removed, while
        /// Environment.GetCommandLineArgs() still has it at index 0. Treating one
        /// as the other either turns an exe path into a settings change or
        /// silently drops the first real flag -- so the difference is dealt with
        /// once, here, and Parse below has one meaning.
        /// </summary>
        private static string[] FromCommandLine(string[] argv)
        {
            if (argv == null || argv.Length <= 1) return new string[0];
            string[] rest = new string[argv.Length - 1];
            Array.Copy(argv, 1, rest, 0, rest.Length);
            return rest;
        }

        /// <summary>
        /// Every element is a flag. Anything unrecognised is ignored, so a flag
        /// from a newer build reaching an older one is not an error.
        /// </summary>
        public static StartupOptions Parse(string[] argv)
        {
            StartupOptions o = new StartupOptions();
            if (argv == null) return o;
            foreach (string a in argv)
            {
                if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase)) o.Minimized = true;
                else if (string.Equals(a, "--devtools", StringComparison.OrdinalIgnoreCase)) o.DevTools = true;
                else if (string.Equals(a, "--no-devtools", StringComparison.OrdinalIgnoreCase)) o.DevTools = false;
            }
            return o;
        }
    }

    internal static class Autostart
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "RotmanFrontDesk";

        /// <summary>
        /// The arguments the startup entry should use.
        ///
        /// --minimized is not conditional on anything: starting in the tray is
        /// what "start with Windows" means in this app -- the desk should be ready
        /// before anyone arrives, without a window thrown over whatever the
        /// operator was already doing. That was the old value's only flag, and it
        /// stays.
        ///
        /// --no-devtools is the part that was being lost. DevTools are on by
        /// default and the flag is the only way to turn them off, so an install
        /// started that way has to come back that way: on a kiosk, DevTools are a
        /// way around the very PIN the kiosk screen exists to protect.
        /// </summary>
        public static string Args()
        {
            return StartupOptions.Current.DevTools ? "--minimized" : "--minimized --no-devtools";
        }

        /// <summary>The command Windows will run at logon, as it stands now.</summary>
        public static string Command()
        {
            return "\"" + Application.ExecutablePath + "\" " + Args();
        }

        public static bool IsEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    if (k == null) return false;
                    return k.GetValue(ValueName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// HKCU, so it works for a standard user with no elevation prompt.
        /// </summary>
        public static void Set(bool enabled)
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (k == null) throw new InvalidOperationException("Cannot open the Run key for this user.");
                if (enabled)
                {
                    // Not a fixed string: see StartupOptions. A kiosk install
                    // started with --no-devtools must come back up that way.
                    k.SetValue(ValueName, Command());
                }
                else
                {
                    if (k.GetValue(ValueName) != null) k.DeleteValue(ValueName, false);
                }
            }
        }
    }

    public class MainForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const int SW_RESTORE = 9;

        public static string RuntimeVersion;

        private WebView2 _web;
        private NotifyIcon _tray;
        private ToolStripMenuItem _autostartItem;
        private ToolStripMenuItem _devToolsItem;
        private bool _fullScreen;
        private readonly StartupOptions _startup;

        public MainForm(StartupOptions startup)
        {
            _startup = startup;

            Text = "Rotman Front Desk";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 640);
            Size = new Size(1280, 860);
            BackColor = Color.FromArgb(10, 10, 11);
            WindowState = FormWindowState.Maximized;
            KeyPreview = true;

            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);

            BuildTray();
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // Start in the tray when Windows launched us, so autostart does not
            // throw a window over whatever the operator was already doing.
            if (_startup.Minimized)
            {
                WindowState = FormWindowState.Minimized;
                Hide();
            }
            try
            {
                await InitWebViewAsync();
            }
            catch (Exception ex)
            {
                Paths.Log("init failed: " + ex);
                MessageBox.Show(
                    "Front Desk could not start.\r\n\r\n" + ex.Message +
                    "\r\n\r\nA log was written to:\r\n" + Paths.LogFile,
                    "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Exit();
            }
        }

        private async System.Threading.Tasks.Task InitWebViewAsync()
        {
            try
            {
                RuntimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception)
            {
                ShowRuntimeMissing();
                Application.Exit();
                return;
            }

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(
                null, Paths.BrowserData, null);
            await _web.EnsureCoreWebView2Async(env);

            CoreWebView2Settings s = _web.CoreWebView2.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.AreDevToolsEnabled = _startup.DevTools;
            s.IsSwipeNavigationEnabled = false;
            // Browser accelerators stay on so Ctrl+C/Ctrl+V work in the app's
            // fields; F5 reloading is useful rather than harmful here.

            _web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                Build.VirtualHost, Paths.Web, CoreWebView2HostResourceAccessKind.DenyCors);
            _web.CoreWebView2.AddHostObjectToScript("frontDeskHost", new Bridge(this));
            _web.CoreWebView2.DownloadStarting += OnDownloadStarting;
            _web.CoreWebView2.ProcessFailed += OnProcessFailed;
            _web.CoreWebView2.NavigationStarting += OnNavigationStarting;
            _web.CoreWebView2.FrameNavigationStarting += OnFrameNavigationStarting;
            _web.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
            _web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
            _web.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

            Paths.Log("start: version=" + Build.Version + " runtime=" + RuntimeVersion +
                      " data=" + Paths.Data + " portable=" + Paths.Portable);

            _web.CoreWebView2.Navigate("https://" + Build.VirtualHost + "/index.html");
        }

        private void ShowRuntimeMissing()
        {
            Paths.Log("WebView2 runtime not found");
            DialogResult r = MessageBox.Show(
                "Front Desk needs the Microsoft Edge WebView2 Runtime, which is not installed.\r\n\r\n" +
                "Open the download page now?",
                "Front Desk", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(
                        "https://go.microsoft.com/fwlink/p/?LinkId=2124703") { UseShellExecute = true });
                }
                catch
                {
                }
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
                Paths.Log("navigation failed: " + e.WebErrorStatus);
        }

        /// <summary>
        /// True for the app's own pages: the virtual host, over https.
        ///
        /// https matters rather than being picked for tidiness -- the folder
        /// mapping is served over the virtual https origin, and
        /// http://frontdesk.local is a *different* origin with its own empty
        /// storage, so allowing it would be allowing a second, separate copy of
        /// the desk with none of its records in it.
        ///
        /// about:blank is allowed because it is inert: opaque origin, no storage,
        /// and only reachable from a page that already has full access.
        ///
        /// internal rather than private so the host's own test suite -- which is
        /// compiled against this file -- can hold the decision table to account.
        /// The allow/deny boundary is the part of this that has to be right.
        /// </summary>
        internal static bool IsAppUri(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (string.Equals(uri, "about:blank", StringComparison.OrdinalIgnoreCase)) return true;
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            return u.Scheme == Uri.UriSchemeHttps &&
                   string.Equals(u.Host, Build.VirtualHost, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// A phone number or an address rather than a page. Windows has handlers
        /// for all three (Phone Link, Mail) and the overdue list's Call and Text
        /// buttons are built from exactly these schemes.
        /// </summary>
        internal static bool IsShellScheme(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (uri.Length > 512) return false;
            return uri.StartsWith("tel:", StringComparison.OrdinalIgnoreCase) ||
                   uri.StartsWith("sms:", StringComparison.OrdinalIgnoreCase) ||
                   uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Hand a phone number or an address to Windows. Returns false for
        /// anything else.
        ///
        /// This is here because the guard below would otherwise turn those Call
        /// and Text buttons into dead ones: a WebView2 navigation to tel: does not
        /// reach the shell on its own, it just fails. The app is for a desk that
        /// phones people.
        ///
        /// Not on a locked-down install, though. --no-devtools is how a kiosk is
        /// marked, and a public tablet reaching the shell at all -- a Phone Link
        /// window, a mail composer, whatever the handler turns out to be -- is a
        /// way off the page it is supposed to be showing. The kiosk has no overdue
        /// list; nothing legitimate is lost by refusing there.
        /// </summary>
        private bool TryShellScheme(string uri)
        {
            if (!IsShellScheme(uri)) return false;
            if (!_startup.DevTools)
            {
                Paths.Log("refused shell link on a locked-down install: " + uri);
                return true;
            }
            try
            {
                Uri u;
                // Parsed before it is handed to the shell: an unparseable string is
                // not something to launch a process over.
                if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
                Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
                return true;
            }
            catch (Exception ex)
            {
                // No handler registered, or the shell refused it. The click did
                // nothing, and the log is where a "the Call button doesn't work"
                // report gets answered from.
                Paths.Log("could not open " + uri + ": " + ex.Message);
                return true;
            }
        }

        /// <summary>
        /// Nothing but the app's own pages is allowed to load.
        ///
        /// The kiosk is a public tablet showing a screen with a PIN behind it,
        /// and this WebView has a host object attached to it -- the page can call
        /// into the Windows side to write files, read folders and change the
        /// startup entry. That object is scoped to the virtual host, so a
        /// navigated page never gets it; but a page that replaced the app in this
        /// window would sit in front of a signed-in desk on a machine the desk
        /// trusts, and that is not a state worth being able to reach by a stray
        /// click or a paste into the address bar of whatever ends up in front.
        /// There is no route back, so the navigation never starts.
        /// </summary>
        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsAppUri(e.Uri)) return;
            // A phone number or an address is not a page: give it to Windows.
            if (TryShellScheme(e.Uri)) { e.Cancel = true; return; }
            Paths.Log("blocked navigation: " + e.Uri);
            e.Cancel = true;
        }

        /// <summary>
        /// The same rule for frames. This app has no frames today; the handler is
        /// here so that adding one cannot quietly add a way to load a second
        /// origin inside the page.
        /// </summary>
        private void OnFrameNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsAppUri(e.Uri)) return;
            if (TryShellScheme(e.Uri)) { e.Cancel = true; return; }
            Paths.Log("blocked frame navigation: " + e.Uri);
            e.Cancel = true;
        }

        /// <summary>
        /// No popups. Unhandled, WebView2 opens its own window for these, which
        /// would be a browser window outside everything above.
        /// </summary>
        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            if (TryShellScheme(e.Uri)) { e.Handled = true; return; }
            Paths.Log("blocked new window: " + e.Uri);
            e.Handled = true;
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Paths.Log("webview process failed: " + e.ProcessFailedKind);
            OnUi(delegate
            {
                DialogResult r = MessageBox.Show(
                    "The page stopped responding (" + e.ProcessFailedKind + ").\r\n\r\nReload it?",
                    "Front Desk", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes && _web.CoreWebView2 != null)
                    _web.CoreWebView2.Reload();
            });
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                Paths.Log("page: " + e.TryGetWebMessageAsString());
            }
            catch
            {
            }
        }

        /// <summary>
        /// Give downloads a real Save dialog instead of dropping files into
        /// whatever Edge last used. Defaults to the backups folder.
        /// </summary>
        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            OnUi(delegate
            {
                try
                {
                    string suggested = Path.GetFileName(e.ResultFilePath);
                    if (string.IsNullOrEmpty(suggested)) suggested = "frontdesk-export.json";
                    using (SaveFileDialog sfd = new SaveFileDialog())
                    {
                        sfd.FileName = suggested;
                        sfd.InitialDirectory = Paths.Backups;
                        sfd.Filter = "JSON backup (*.json)|*.json|CSV export (*.csv)|*.csv|All files (*.*)|*.*";
                        sfd.FilterIndex = suggested.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? 2 : 1;
                        sfd.OverwritePrompt = true;
                        if (sfd.ShowDialog(this) == DialogResult.OK)
                        {
                            e.ResultFilePath = sfd.FileName;
                            e.Handled = true;
                        }
                        else
                        {
                            e.Cancel = true;
                        }
                    }
                }
                catch (Exception ex)
                {
                    Paths.Log("download dialog failed: " + ex);
                }
            });
        }

        /// <summary>Save-file dialog for the bridge. Must run on the UI thread.</summary>
        public string AskSavePath(string suggestedName)
        {
            string result = null;
            OnUi(delegate
            {
                try
                {
                    using (SaveFileDialog sfd = new SaveFileDialog())
                    {
                        sfd.FileName = string.IsNullOrEmpty(suggestedName)
                            ? "frontdesk-backup-" + DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".json"
                            : suggestedName;
                        sfd.InitialDirectory = Paths.Backups;
                        sfd.Filter = "JSON backup (*.json)|*.json|All files (*.*)|*.*";
                        sfd.OverwritePrompt = true;
                        if (sfd.ShowDialog(this) == DialogResult.OK) result = sfd.FileName;
                    }
                }
                catch (Exception ex)
                {
                    Paths.Log("save dialog failed: " + ex);
                }
            });
            return result;
        }

        public string AskOpenPath()
        {
            string result = null;
            OnUi(delegate
            {
                try
                {
                    using (OpenFileDialog ofd = new OpenFileDialog())
                    {
                        ofd.InitialDirectory = Directory.Exists(Paths.Backups) ? Paths.Backups : Paths.Data;
                        ofd.Filter = "JSON backup (*.json)|*.json|All files (*.*)|*.*";
                        ofd.CheckFileExists = true;
                        if (ofd.ShowDialog(this) == DialogResult.OK) result = ofd.FileName;
                    }
                }
                catch (Exception ex)
                {
                    Paths.Log("open dialog failed: " + ex);
                }
            });
            return result;
        }

        private void OnUi(Action action)
        {
            if (IsDisposed) return;
            try
            {
                // Invoke, not BeginInvoke: the dialog helpers below read a result
                // the action assigns. BeginInvoke returns immediately and would
                // hand back null before the operator had even seen the dialog.
                if (InvokeRequired) Invoke(action);
                else action();
            }
            catch (Exception ex)
            {
                Paths.Log("OnUi failed: " + ex.Message);
            }
        }

        private void BuildTray()
        {
            _tray = new NotifyIcon();
            _tray.Icon = MakeIcon();
            _tray.Text = "Rotman Front Desk";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowFromTray(); };

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Show Front Desk", null, delegate { ShowFromTray(); });
            menu.Items.Add(new ToolStripSeparator());
            // Async lambdas are C# 5; `async delegate { }` anonymous methods are not.
            EventHandler backupNow = async (s2, e2) =>
            {
                if (_web.CoreWebView2 == null) return;
                await _web.CoreWebView2.ExecuteScriptAsync(
                    "window.app && window.app.runBackupNow && window.app.runBackupNow()");
                ShowFromTray();
            };
            menu.Items.Add("Back up now", null, backupNow);
            menu.Items.Add("Open data folder", null, delegate { OpenFolder(Paths.Data); });
            menu.Items.Add("Open backup folder", null, delegate { OpenFolder(Paths.Backups); });
            menu.Items.Add(new ToolStripSeparator());

            _autostartItem = new ToolStripMenuItem("Start with Windows");
            _autostartItem.CheckOnClick = false;
            _autostartItem.Click += delegate
            {
                try
                {
                    Autostart.Set(!Autostart.IsEnabled());
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Could not change the startup setting.\r\n\r\n" + ex.Message,
                        "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                SyncMenu();
            };
            menu.Items.Add(_autostartItem);
            _devToolsItem = new ToolStripMenuItem("Developer tools");
            _devToolsItem.CheckOnClick = false;
            _devToolsItem.Click += delegate { ToggleDevTools(); };
            _devToolsItem.Visible = _startup.DevTools;
            menu.Items.Add(_devToolsItem);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Reload", null, delegate
            {
                if (_web.CoreWebView2 != null) _web.CoreWebView2.Reload();
            });
            menu.Items.Add("Exit", null, delegate { ReallyExit(); });

            _tray.ContextMenuStrip = menu;
            SyncMenu();
        }

        private void SyncMenu()
        {
            try
            {
                if (_autostartItem != null)
                {
                    _autostartItem.Checked = Autostart.IsEnabled();
                    // The flags are part of the setting now, so they are worth
                    // showing: on a kiosk the difference between this entry and a
                    // plain one is whether DevTools come back at the next logon.
                    _autostartItem.ToolTipText = "Starts as: " + Autostart.Command();
                }
                if (_devToolsItem != null && _web.CoreWebView2 != null)
                    _devToolsItem.Checked = _web.CoreWebView2.Settings.AreDevToolsEnabled;
            }
            catch
            {
            }
        }

        private void ToggleDevTools()
        {
            if (_web.CoreWebView2 == null) return;
            bool next = !_web.CoreWebView2.Settings.AreDevToolsEnabled;
            _web.CoreWebView2.Settings.AreDevToolsEnabled = next;
            if (next) _web.CoreWebView2.OpenDevToolsWindow();
            SyncMenu();
        }

        private void OpenFolder(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Paths.Log("open folder failed: " + ex);
            }
        }

        public void ShowFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            SetForegroundWindow(Handle);
        }

        private void ReallyExit()
        {
            if (_tray != null) _tray.Visible = false;
            Close();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.F11)
            {
                ToggleFullScreen();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.F12 && _startup.DevTools)
            {
                ToggleDevTools();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Escape && _fullScreen)
            {
                ToggleFullScreen();
                e.Handled = true;
            }
        }

        private void ToggleFullScreen()
        {
            _fullScreen = !_fullScreen;
            if (_fullScreen)
            {
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
                TopMost = true;
            }
            else
            {
                TopMost = false;
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = FormWindowState.Maximized;
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // The X button exits. Closing to the tray would be the friendlier
            // default for a kiosk, but an invisible running process is a
            // support call waiting to happen -- the tray icon covers the
            // "keep it handy" case without hiding anything.
            base.OnFormClosing(e);
            if (_tray != null) _tray.Visible = false;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                }
                if (_web != null) _web.Dispose();
            }
            base.Dispose(disposing);
        }

        /// <summary>
        /// A magenta tile with "FD", drawn rather than shipped as a resource.
        ///
        /// This is the same mark as the exe's own icon, which tools\make-icon.ps1
        /// draws into host\frontdesk.ico at seven sizes and csc compiles in with
        /// /win32icon. It is drawn again here rather than loaded out of the exe
        /// because NotifyIcon wants a fixed 32x32 bitmap and this way the tray
        /// does not depend on the icon resource being present or on what
        /// Icon.ExtractAssociatedIcon makes of its alpha channel. The two are
        /// meant to match: change one, change the other.
        /// </summary>
        private static Icon MakeIcon()
        {
            try
            {
                using (Bitmap bmp = new Bitmap(32, 32))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.Clear(Color.Transparent);
                        using (SolidBrush bg = new SolidBrush(ColorTranslator.FromHtml("#E6007E")))
                        using (GraphicsPath path = RoundedRect(new Rectangle(0, 0, 32, 32), 7))
                        {
                            g.FillPath(bg, path);
                        }
                        using (Font f = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel))
                        using (SolidBrush fg = new SolidBrush(Color.White))
                        using (StringFormat sf = new StringFormat())
                        {
                            sf.Alignment = StringAlignment.Center;
                            sf.LineAlignment = StringAlignment.Center;
                            g.DrawString("FD", f, fg, new RectangleF(0, 0, 32, 32), sf);
                        }
                    }
                    IntPtr h = bmp.GetHicon();
                    try
                    {
                        return (Icon)Icon.FromHandle(h).Clone();
                    }
                    finally
                    {
                        DestroyIcon(h);
                    }
                }
            }
            catch
            {
                return SystemIcons.Application;
            }
        }

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr handle);

        private static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            int d = radius * 2;
            GraphicsPath p = new GraphicsPath();
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        /// <summary>Bring an already-running copy forward rather than starting a second.</summary>
        public static void ActivateExisting()
        {
            try
            {
                Process current = Process.GetCurrentProcess();
                Process[] all = Process.GetProcessesByName(current.ProcessName);
                foreach (Process p in all)
                {
                    if (p.Id == current.Id) continue;
                    if (p.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindow(p.MainWindowHandle, SW_RESTORE);
                    SetForegroundWindow(p.MainWindowHandle);
                    return;
                }
            }
            catch (Exception ex)
            {
                Paths.Log("activate existing failed: " + ex.Message);
            }
        }
    }

    internal static class Program
    {
        private static Mutex _instance;

        [STAThread]
        private static void Main(string[] args)
        {
            bool createdNew;
            _instance = new Mutex(true, @"Local\RotmanFrontDesk.SingleInstance", out createdNew);
            if (!createdNew)
            {
                MainForm.ActivateExisting();
                return;
            }

            // DevTools are on by default: this is a staff tool and the built-in
            // debugging is worth having. A kiosk tablet running the same build
            // should be started with --no-devtools, since the kiosk is the
            // public surface and DevTools would be a way around its PIN.
            //
            // Parsed once, in StartupOptions, because the same flags have to be
            // written back into the autostart entry -- a second parser here is a
            // second copy of the defaults, and the two drifted: the Run value
            // always said "--minimized" and nothing else, so a --no-devtools
            // kiosk came back from a reboot with DevTools enabled.
            StartupOptions startup = StartupOptions.Current;

            Paths.Resolve();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
            {
                Paths.Log("unhandled UI exception: " + e.Exception);
                MessageBox.Show("Something went wrong:\r\n\r\n" + e.Exception.Message +
                                "\r\n\r\nLogged to:\r\n" + Paths.LogFile,
                                "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };

            MainForm form = new MainForm(startup);
            Application.Run(form);

            if (_instance != null)
            {
                try { _instance.ReleaseMutex(); }
                catch { }
            }
        }
    }
}
