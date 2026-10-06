// RFrontDesk — Windows host.
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

        /// <summary>The newest log is trimmed to this; one older file is kept beside it.</summary>
        public const long MaxLogBytes = 1024 * 1024;

        public static void Resolve()
        {
            Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            Web = Path.Combine(Root, "web");
            string fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "FrontDesk", "data");
            Data = ChooseData(Root, fallback, IsWritable, Directory.Exists, out Portable);
            Backups = Path.Combine(Data, "backups");
            BrowserData = Path.Combine(Data, "browser");
            LogFile = Path.Combine(Data, "frontdesk.log");
            SafeCreate(Data);
            SafeCreate(Backups);
            RollLog(LogFile, MaxLogBytes);
        }

        /// <summary>
        /// Which data folder to open. The one beside the app wins whenever it
        /// already holds a database, even if the write check failed this time.
        ///
        /// It used to be the write check alone. One bad moment -- an antivirus
        /// scan holding the probe file, a slow network share -- sent that launch
        /// to an empty database under LocalAppData, and the desk opened with no
        /// records at all. A folder that has a database is the desk's; if it
        /// really cannot be written, the app says so when it tries.
        /// </summary>
        internal static string ChooseData(string root, string fallback,
            Func<string, bool> writable, Func<string, bool> dirExists, out bool portable)
        {
            string preferred = Path.Combine(root, "data");
            if (dirExists(Path.Combine(preferred, "browser")) || writable(preferred))
            {
                portable = true;
                return preferred;
            }
            portable = false;
            return fallback;
        }

        private static void SafeCreate(string dir)
        {
            try { Directory.CreateDirectory(dir); }
            catch { }
        }

        private static bool IsWritable(string dir)
        {
            string probe;
            try
            {
                Directory.CreateDirectory(dir);
                probe = Path.Combine(dir, ".write-probe");
                File.WriteAllText(probe, "1");
            }
            catch
            {
                return false;
            }
            // The write is the test. A delete that fails -- a scanner still has
            // the file open -- says nothing about whether the folder is writable.
            try { File.Delete(probe); }
            catch { }
            return true;
        }

        /// <summary>
        /// Keep the log from growing for ever: past the limit it becomes
        /// frontdesk.log.1 (replacing the last one) and a fresh log starts.
        /// </summary>
        internal static void RollLog(string logFile, long maxBytes)
        {
            try
            {
                FileInfo f = new FileInfo(logFile);
                if (!f.Exists || f.Length <= maxBytes) return;
                string old = logFile + ".1";
                if (File.Exists(old)) File.Delete(old);
                File.Move(logFile, old);
            }
            catch
            {
            }
        }

        /// <summary>
        /// One line, no control characters, and a sane length. For anything the
        /// page sends: a message with a newline in it could forge a log line.
        /// </summary>
        internal static string OneLine(string s, int max)
        {
            if (s == null) return "";
            StringBuilder b = new StringBuilder(Math.Min(s.Length, max));
            foreach (char c in s)
            {
                if (b.Length >= max) break;
                b.Append(char.IsControl(c) ? ' ' : c);
            }
            if (s.Length > max) b.Append("...");
            return b.ToString();
        }

        private static int _logWrites;

        public static void Log(string message)
        {
            try
            {
                // Checked now and then rather than on every line: a desk left
                // running for months never restarts to trim it.
                if (++_logWrites % 200 == 0) RollLog(LogFile, MaxLogBytes);
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

        /// <summary>
        /// The last part of the log, read from the end of the file. The whole
        /// file used to be read into memory to show its final 20,000 characters.
        /// </summary>
        internal static string Tail(string path, int maxChars)
        {
            if (!File.Exists(path)) return "";
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long want = Math.Min(fs.Length, (long)maxChars * 4);
                fs.Seek(-want, SeekOrigin.End);
                byte[] buf = new byte[want];
                int got = 0;
                while (got < buf.Length)
                {
                    int n = fs.Read(buf, got, buf.Length - got);
                    if (n <= 0) break;
                    got += n;
                }
                string text = Encoding.UTF8.GetString(buf, 0, got);
                if (text.Length > maxChars) text = text.Substring(text.Length - maxChars);
                // Started mid-file: drop the partial first line.
                if (want < fs.Length)
                {
                    int nl = text.IndexOf('\n');
                    if (nl >= 0) text = text.Substring(nl + 1);
                }
                return text;
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
            string tmp = null;
            try
            {
                if (json == null || json.Length == 0)
                    return Fail("Nothing to write — the backup was empty.");

                string name = Sanitize(suggestedName);
                if (name.Length == 0)
                    name = "frontdesk-backup-" + DateTime.Now.ToString("yyyy-MM-dd-HHmmss", CultureInfo.InvariantCulture) + ".json";
                if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) name += ".json";

                // Written beside the real name and moved into place only once it
                // has read back intact. The name is per-day, so writing straight
                // to it meant a second backup that failed half-way -- a full disk,
                // say -- truncated the day's good one, and the broken file then
                // headed the Restore list as the newest. The temporary name does
                // not end in .json, so List() and Rotate() never see it.
                string path = Path.Combine(Paths.Backups, name);
                tmp = path + ".partial";
                File.WriteAllText(tmp, json, new UTF8Encoding(false));

                // Read it back and confirm it is the same length and still looks
                // like the export it claims to be.
                string verify = File.ReadAllText(tmp);
                long bytes = verify.Length;
                bool sizeOk = bytes == json.Length;
                bool shapeOk = verify.TrimStart().StartsWith("{", StringComparison.Ordinal) &&
                               verify.IndexOf("\"items\"", StringComparison.Ordinal) >= 0;

                if (!(sizeOk && shapeOk))
                {
                    // Nothing on disk changes: the earlier backups stay, and so
                    // does any that already carries today's name. Rotating here
                    // used to delete the oldest good backup to make room for one
                    // that had just failed its own check.
                    TryDelete(tmp);
                    tmp = null;
                    Paths.Log("backup failed verification, not kept: " + path);
                    return Fail("The backup did not read back intact, so it was not kept. The earlier backups are untouched.");
                }

                if (File.Exists(path))
                    File.Replace(tmp, path, null);
                else
                    File.Move(tmp, path);
                tmp = null;

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
                b.Append("}");
                Paths.Log("backup written: " + path + " (" + bytes + " bytes, verified=true)");
                return b.ToString();
            }
            catch (Exception ex)
            {
                if (tmp != null) TryDelete(tmp);
                return Error(ex);
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
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
                // Only the tail, read from the end of the file.
                string text = Paths.Tail(Paths.LogFile, 20000);
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
            Paths.Log("client: " + Paths.OneLine(message, 2000));
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

        /// <summary>
        /// The app's own backups: frontdesk-backup-2026-10-06.json, or with a
        /// time on the end. Only these are ever rotated out.
        /// </summary>
        internal static bool IsAutoBackupName(string name)
        {
            return name != null && AutoBackupName.IsMatch(name);
        }

        private static readonly System.Text.RegularExpressions.Regex AutoBackupName =
            new System.Text.RegularExpressions.Regex(
                @"^frontdesk-backup-\d{4}-\d{2}-\d{2}(-\d{6})?\.json$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                System.Text.RegularExpressions.RegexOptions.CultureInvariant);

        /// <summary>
        /// Keep the newest N of the app's own backups, delete the older ones.
        /// Returns what went.
        ///
        /// Any other .json in the folder -- a copy someone saved there by hand,
        /// an export from another desk -- is shown in the restore list but never
        /// deleted. It used to count toward the 30 and go like any other.
        /// </summary>
        private static List<string> Rotate()
        {
            List<string> gone = new List<string>();
            List<FileInfo> files = List().FindAll(delegate(FileInfo f) { return IsAutoBackupName(f.Name); });
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

        // Setup: see Installer. These run instead of the app.
        public bool Install;
        public bool Uninstall;
        public bool Quiet;
        public bool AutostartOnInstall;
        public bool NoDesktopShortcut;
        public bool DeleteData;

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
        /// from a newer build reaching an older one is not an error -- with one
        /// exception: a misspelling of the lock flag ("--no-devtool",
        /// "--nodevtools") locks. It used to be ignored, which left a public
        /// kiosk unlocked with nothing to say so. Failing closed is the safe way
        /// round: a locked desk is a nuisance, an unlocked one is a hole.
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
                // The plain-English name for the same lock, used by the installer.
                else if (string.Equals(a, "--kiosk", StringComparison.OrdinalIgnoreCase)) o.DevTools = false;
                else if (string.Equals(a, "--install", StringComparison.OrdinalIgnoreCase)) o.Install = true;
                else if (string.Equals(a, "--uninstall", StringComparison.OrdinalIgnoreCase)) o.Uninstall = true;
                else if (string.Equals(a, "--quiet", StringComparison.OrdinalIgnoreCase)) o.Quiet = true;
                else if (string.Equals(a, "--autostart", StringComparison.OrdinalIgnoreCase)) o.AutostartOnInstall = true;
                else if (string.Equals(a, "--no-desktop", StringComparison.OrdinalIgnoreCase)) o.NoDesktopShortcut = true;
                else if (string.Equals(a, "--delete-data", StringComparison.OrdinalIgnoreCase)) o.DeleteData = true;
                else if (a != null && a.StartsWith("-", StringComparison.Ordinal))
                {
                    o.Unknown.Add(a);
                    string flat = a.Replace("-", "").Replace("_", "").ToLowerInvariant();
                    if (flat.StartsWith("no") && flat.Contains("dev")) o.DevTools = false;
                }
            }
            return o;
        }

        /// <summary>Flags on the command line that this build did not recognise.</summary>
        public List<string> Unknown = new List<string>();

        /// <summary>
        /// A locked-down kiosk: started with --no-devtools. The public is at the
        /// screen, so the app keeps them on the page -- no way to the desktop,
        /// the file system or out of the app from inside it.
        /// </summary>
        public bool Kiosk { get { return !DevTools; } }
    }

    internal static class Autostart
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "RFrontDesk";

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
            return ArgsFor(StartupOptions.Current.DevTools);
        }

        internal static string ArgsFor(bool devTools)
        {
            return devTools ? "--minimized" : "--minimized --no-devtools";
        }

        /// <summary>The command Windows will run at logon, as it stands now.</summary>
        public static string Command()
        {
            return CommandFor(Application.ExecutablePath, StartupOptions.Current.DevTools);
        }

        internal static string CommandFor(string exePath, bool devTools)
        {
            return "\"" + exePath + "\" " + ArgsFor(devTools);
        }

        /// <summary>The exe a stored Run value starts: the quoted part, or up to the first space.</summary>
        internal static string ExeOf(string command)
        {
            if (string.IsNullOrEmpty(command)) return "";
            string c = command.Trim();
            if (c.StartsWith("\"", StringComparison.Ordinal))
            {
                int end = c.IndexOf('"', 1);
                return end > 1 ? c.Substring(1, end - 1) : c.Substring(1);
            }
            int sp = c.IndexOf(' ');
            return sp > 0 ? c.Substring(0, sp) : c;
        }

        internal static bool IsLocked(string command)
        {
            if (command == null) return false;
            return command.IndexOf("--no-devtools", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   command.IndexOf("--kiosk", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// What an existing startup entry should be changed to, or null to leave it.
        ///
        /// The entry used to be written once and never looked at again, so moving
        /// the folder, or installing over an old copy, left Windows starting an
        /// exe that was gone. It is now corrected at launch -- but only when it is
        /// this copy's entry (same exe) or points at nothing: a second copy run
        /// from a USB stick must not take the startup entry over from the
        /// installed one. And a correction never drops the lock: if the stored
        /// entry is locked, the new one is too, even when this launch is not.
        /// </summary>
        internal static string Repair(string stored, string exePath, bool devTools, Func<string, bool> fileExists)
        {
            if (string.IsNullOrEmpty(stored)) return null;
            string storedExe = ExeOf(stored);
            bool ours = string.Equals(storedExe, exePath, StringComparison.OrdinalIgnoreCase);
            if (!ours && fileExists(storedExe)) return null;
            bool locked = IsLocked(stored) || !devTools;
            string want = CommandFor(exePath, !locked);
            return string.Equals(stored, want, StringComparison.Ordinal) ? null : want;
        }

        /// <summary>Run at every launch: fix this copy's startup entry if it is out of date.</summary>
        public static void RepairIfStale()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (k == null) return;
                    string stored = k.GetValue(ValueName) as string;
                    string fixedValue = Repair(stored, Application.ExecutablePath,
                        StartupOptions.Current.DevTools, File.Exists);
                    if (fixedValue == null) return;
                    k.SetValue(ValueName, fixedValue);
                    Paths.Log("startup entry updated to: " + fixedValue);
                }
            }
            catch (Exception ex)
            {
                Paths.Log("could not check the startup entry: " + ex.Message);
            }
        }

        /// <summary>The stored Run value, or null.</summary>
        internal static string Stored()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    return k == null ? null : k.GetValue(ValueName) as string;
                }
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Write the entry for a given exe. Used by the installer.</summary>
        internal static void SetFor(string exePath, bool devTools)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                k.SetValue(ValueName, CommandFor(exePath, devTools));
            }
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

    /// <summary>
    /// Install and uninstall, for one Windows user, with no admin rights.
    ///
    ///   RFrontDesk.exe --install      (the zip's "Install Front Desk.cmd" runs this)
    ///   RFrontDesk.exe --uninstall    (what Settings > Apps runs)
    ///   add --quiet for IT: no windows; with --install, --kiosk, --autostart and
    ///   --no-desktop choose the options; with --uninstall, --delete-data removes
    ///   the records too.
    ///
    /// Why it lives in the app rather than in a setup.exe: a self-extracting
    /// setup is the shape SentinelOne and CrowdStrike delete on sight (see
    /// docs\EDR_AND_SIGNING.md), and a second exe is a second binary to sign and
    /// allowlist. This way the one signed exe does everything.
    ///
    /// It installs to %LOCALAPPDATA%\Programs\RFrontDesk -- the per-user
    /// place Windows itself suggests -- because the app keeps its data beside
    /// itself and Program Files is not writable without admin rights.
    /// </summary>
    internal static class Installer
    {
        public const string ExeName = "RFrontDesk.exe";
        public const string AppName = "RFrontDesk";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\RFrontDesk";
        private const string StagingName = ".setup-new";
        private const string LeftoverPrefix = "RFrontDesk-removed-";

        public static string DefaultInstallDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", AppName);
        }

        private static string StartMenuLink()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk");
        }

        private static string DesktopLink()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
        }

        /// <summary>The files without which the app cannot start, or null when all are there.</summary>
        internal static string MissingFiles(string dir)
        {
            string[] need = { ExeName, "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
                              "WebView2Loader.dll", Path.Combine("web", "index.html") };
            List<string> missing = new List<string>();
            foreach (string n in need)
                if (!File.Exists(Path.Combine(dir, n))) missing.Add(n);
            return missing.Count == 0 ? null : string.Join(", ", missing.ToArray());
        }

        internal static string Full(string path)
        {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        internal static bool SamePath(string a, string b)
        {
            return string.Equals(Full(a), Full(b), StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>True when path is dir itself or anything under it.</summary>
        internal static bool IsInside(string path, string dir)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(dir)) return false;
            try
            {
                string p = Full(path);
                string d = Full(dir);
                return string.Equals(p, d, StringComparison.OrdinalIgnoreCase) ||
                       p.StartsWith(d + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        // --- Install ---------------------------------------------------------

        public static int Install(StartupOptions o)
        {
            string src = Full(AppDomain.CurrentDomain.BaseDirectory);
            string dst = DefaultInstallDir();
            string missing = MissingFiles(src);
            if (missing != null)
            {
                return Problem(o, "Some of Front Desk's files are missing: " + missing + ".\r\n\r\n" +
                    "If you opened this from inside the zip, close it, right-click the zip, choose " +
                    "Extract All, and run Install from the folder that makes.");
            }
            if (!SamePath(src, dst) && (IsInside(src, dst) || IsInside(dst, src)))
                return Problem(o, "This copy is in the way of the install folder. Move it somewhere else (Downloads is fine) and run Install again.");

            // Defaults: what this user chose last time, if anything.
            bool kiosk = !o.DevTools || ReadFlag("Kiosk", false);
            bool desktop = !o.NoDesktopShortcut && ReadFlag("DesktopShortcut", true);
            // Kept as it was unless asked: an update must not quietly drop the
            // startup entry a desk relies on after a reboot.
            string stored = Autostart.Stored();
            bool autostart = o.AutostartOnInstall ||
                (stored != null && (!o.Quiet || IsInside(Autostart.ExeOf(stored), dst)));
            bool open = !o.Quiet;

            if (!o.Quiet)
            {
                bool again = File.Exists(Path.Combine(dst, ExeName));
                using (SetupForm f = new SetupForm(
                    again ? "Update " + AppName : "Install " + AppName,
                    again ? "Update Front Desk" : "Install Front Desk",
                    (again ? "This replaces the app with this version. The desk's records and backups are kept." :
                             "Front Desk will be installed for you only. No admin rights are needed.") +
                    "\r\n\r\nFolder: " + dst,
                    again ? "Update" : "Install"))
                {
                    CheckBox cDesk = f.AddOption("Put a shortcut on the desktop", desktop, null);
                    CheckBox cAuto = f.AddOption("Start Front Desk when I sign in to Windows", autostart, null);
                    CheckBox cKiosk = f.AddOption("This is a public tablet: lock it down", kiosk,
                        "Full screen, no way to close it or reach Windows from the app. Staff still sign in by holding the logo.");
                    CheckBox cOpen = f.AddOption("Open Front Desk when done", true, null);
                    if (f.ShowDialog() != DialogResult.OK) return 1;
                    desktop = cDesk.Checked;
                    autostart = cAuto.Checked;
                    kiosk = cKiosk.Checked;
                    open = cOpen.Checked;
                }
            }

            try
            {
                StopRunning(o.Quiet);
                if (!SamePath(src, dst)) CopyApp(src, dst);
                string exe = Path.Combine(dst, ExeName);
                string args = kiosk ? "--no-devtools" : "";

                MakeShortcut(StartMenuLink(), exe, args, dst);
                if (desktop) MakeShortcut(DesktopLink(), exe, args, dst);
                else TryDeleteFile(DesktopLink());

                if (autostart) Autostart.SetFor(exe, !kiosk);
                else
                {
                    RemoveRunIfInside(dst);
                    RemoveRunIfInside(src);
                }

                WriteUninstallEntry(dst, exe, kiosk, desktop);

                if (open)
                    Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, WorkingDirectory = dst });
                else if (!o.Quiet)
                    MessageBox.Show("Front Desk is installed. Find it in the Start menu.", AppName,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            catch (Exception ex)
            {
                return Problem(o, "Front Desk could not be installed.\r\n\r\n" + ex.Message);
            }
        }

        /// <summary>
        /// Put the app from src into dst. dst's data folder is never touched; the
        /// rest of the old app goes, so a file dropped from a newer version does
        /// not linger. Copied to a staging folder first, so a full disk or a
        /// locked file stops the install before anything old is removed.
        ///
        /// If dst has no database yet and src does -- the desk was being run from
        /// the unzipped folder before it was installed -- the records come along.
        /// </summary>
        internal static void CopyApp(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            string stage = Path.Combine(dst, StagingName);
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
            CopyTree(src, stage, Path.Combine(src, "data"), true);

            foreach (string f in Directory.GetFiles(dst)) File.Delete(f);
            foreach (string d in Directory.GetDirectories(dst))
            {
                string name = Path.GetFileName(d);
                if (string.Equals(name, "data", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(name, StagingName, StringComparison.OrdinalIgnoreCase)) continue;
                Directory.Delete(d, true);
            }
            foreach (string f in Directory.GetFiles(stage))
                File.Move(f, Path.Combine(dst, Path.GetFileName(f)));
            foreach (string d in Directory.GetDirectories(stage))
                Directory.Move(d, Path.Combine(dst, Path.GetFileName(d)));
            Directory.Delete(stage, true);

            string srcData = Path.Combine(src, "data");
            string dstData = Path.Combine(dst, "data");
            if (!Directory.Exists(Path.Combine(dstData, "browser")) && Directory.Exists(srcData))
                CopyTree(srcData, dstData, null, false);
            Directory.CreateDirectory(Path.Combine(dstData, "backups"));
        }

        private static void CopyTree(string from, string to, string skip, bool overwrite)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from))
            {
                string target = Path.Combine(to, Path.GetFileName(f));
                if (!overwrite && File.Exists(target)) continue;
                File.Copy(f, target, overwrite);
            }
            foreach (string d in Directory.GetDirectories(from))
            {
                if (skip != null && SamePath(d, skip)) continue;
                CopyTree(d, Path.Combine(to, Path.GetFileName(d)), skip, overwrite);
            }
        }

        private static void WriteUninstallEntry(string dir, string exe, bool kiosk, bool desktop)
        {
            long bytes = 0;
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                    if (!IsInside(f, Path.Combine(dir, "data"))) bytes += new FileInfo(f).Length;
            }
            catch
            {
            }
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", Build.Version);
                k.SetValue("Publisher", "RFrontDesk");
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
                k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                k.SetValue("QuietUninstallString", "\"" + exe + "\" --uninstall --quiet");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Max(1, bytes / 1024), RegistryValueKind.DWord);
                // Remembered so an update offers the same choices.
                k.SetValue("Kiosk", kiosk ? 1 : 0, RegistryValueKind.DWord);
                k.SetValue("DesktopShortcut", desktop ? 1 : 0, RegistryValueKind.DWord);
            }
        }

        private static bool ReadFlag(string name, bool fallback)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
                {
                    if (k == null) return fallback;
                    object v = k.GetValue(name);
                    return v is int ? (int)v != 0 : fallback;
                }
            }
            catch
            {
                return fallback;
            }
        }

        private static string InstalledDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
                {
                    string dir = k == null ? null : k.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) return dir;
                }
            }
            catch
            {
            }
            string fallback = DefaultInstallDir();
            return File.Exists(Path.Combine(fallback, ExeName)) ? fallback : null;
        }

        // --- Uninstall -------------------------------------------------------

        public static int Uninstall(StartupOptions o)
        {
            string dir = InstalledDir();
            if (dir == null)
                return Problem(o, "Front Desk is not installed for this Windows user, so there is nothing to remove.");

            bool deleteData = o.DeleteData;
            if (!o.Quiet)
            {
                using (SetupForm f = new SetupForm("Remove " + AppName, "Remove Front Desk?",
                    "This removes the app, its shortcuts and its startup entry.", "Remove"))
                {
                    CheckBox cData = f.AddOption("Also delete the desk's records and backups", false,
                        "Leave this off to keep them. Installing again picks them up.");
                    if (f.ShowDialog() != DialogResult.OK) return 1;
                    deleteData = cData.Checked;
                }
                if (deleteData && MessageBox.Show(
                        "Delete every record and backup on this computer? This cannot be undone.",
                        AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
                        MessageBoxDefaultButton.Button2) != DialogResult.Yes)
                    return 1;
            }

            try
            {
                StopRunning(o.Quiet);
                TryDeleteFile(StartMenuLink());
                TryDeleteFile(DesktopLink());
                RemoveRunIfInside(dir);
                try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); }
                catch { }

                List<string> stuck = RemoveApp(dir, deleteData);
                if (deleteData)
                {
                    // The fallback folder an unwritable copy once used.
                    string legacy = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FrontDesk");
                    try { if (Directory.Exists(legacy)) Directory.Delete(legacy, true); }
                    catch { stuck.Add(legacy); }
                }

                if (!o.Quiet)
                {
                    string msg = "Front Desk has been removed.";
                    if (!deleteData && Directory.Exists(Path.Combine(dir, "data")))
                        msg += "\r\n\r\nThe desk's records and backups are still in:\r\n" + Path.Combine(dir, "data") +
                               "\r\n\r\nInstall again to pick them up, or delete that folder.";
                    if (stuck.Count > 0)
                        msg += "\r\n\r\nThese could not be removed and can be deleted by hand:\r\n" +
                               string.Join("\r\n", stuck.ToArray());
                    MessageBox.Show(msg, AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return stuck.Count == 0 ? 0 : 3;
            }
            catch (Exception ex)
            {
                return Problem(o, "Front Desk could not be removed.\r\n\r\n" + ex.Message);
            }
        }

        /// <summary>
        /// Delete the app from dir; the data folder too only when asked. Returns
        /// what could not be removed.
        ///
        /// The running exe cannot be deleted, but Windows does let it be renamed,
        /// so it is moved into %TEMP% and cleaned up the next time any copy of
        /// Front Desk starts. That avoids the usual trick of copying the
        /// uninstaller to %TEMP% and running it from there -- an exe that copies
        /// itself and launches the copy is exactly what endpoint agents look for.
        /// </summary>
        internal static List<string> RemoveApp(string dir, bool deleteData)
        {
            List<string> stuck = new List<string>();
            try { Environment.CurrentDirectory = Path.GetTempPath(); }
            catch { }
            string self = Application.ExecutablePath;
            foreach (string f in Directory.GetFiles(dir))
            {
                try
                {
                    if (SamePath(f, self))
                        File.Move(f, Path.Combine(Path.GetTempPath(), LeftoverPrefix + Guid.NewGuid().ToString("N") + ".tmp"));
                    else
                        File.Delete(f);
                }
                catch
                {
                    stuck.Add(f);
                }
            }
            foreach (string d in Directory.GetDirectories(dir))
            {
                if (!deleteData && string.Equals(Path.GetFileName(d), "data", StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(d, true); }
                catch { stuck.Add(d); }
            }
            try
            {
                if (Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir);
            }
            catch
            {
            }
            return stuck;
        }

        /// <summary>Delete exes an earlier uninstall moved aside. Best effort, every launch.</summary>
        public static void CleanLeftovers()
        {
            try
            {
                foreach (string f in Directory.GetFiles(Path.GetTempPath(), LeftoverPrefix + "*.tmp"))
                    TryDeleteFile(f);
            }
            catch
            {
            }
        }

        // --- Shared ----------------------------------------------------------

        /// <summary>
        /// Close a running copy so its files can be replaced. A copy from this
        /// version closes itself when asked (even a locked kiosk). An older one
        /// does not know how, so it is closed by force -- after asking, unless
        /// this is a quiet install.
        /// </summary>
        private static void StopRunning(bool quiet)
        {
            List<Process> others = Others();
            if (others.Count == 0) return;
            try
            {
                EventWaitHandle ev;
                if (EventWaitHandle.TryOpenExisting(MainForm.QuitEventName, out ev))
                    using (ev) ev.Set();
            }
            catch
            {
            }
            foreach (Process p in others)
            {
                try { p.WaitForExit(8000); }
                catch { }
            }
            others = Others();
            if (others.Count == 0) return;
            if (!quiet && MessageBox.Show(
                    "Front Desk is still open. Close it now so setup can continue?",
                    AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                throw new InvalidOperationException("Close Front Desk, then try again.");
            foreach (Process p in others)
            {
                try
                {
                    p.Kill();
                    p.WaitForExit(5000);
                }
                catch
                {
                }
            }
            if (Others().Count > 0)
                throw new InvalidOperationException("Front Desk is still running. Restart the computer, then try again.");
        }

        private static List<Process> Others()
        {
            List<Process> list = new List<Process>();
            Process me = Process.GetCurrentProcess();
            foreach (Process p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
            {
                try
                {
                    if (p.Id != me.Id && p.SessionId == me.SessionId && !p.HasExited) list.Add(p);
                }
                catch
                {
                }
            }
            return list;
        }

        private static void RemoveRunIfInside(string dir)
        {
            string stored = Autostart.Stored();
            if (stored != null && IsInside(Autostart.ExeOf(stored), dir)) Autostart.Set(false);
        }

        private static void TryDeleteFile(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch { }
        }

        private static int Problem(StartupOptions o, string message)
        {
            if (!o.Quiet)
                MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        private static void MakeShortcut(string linkPath, string target, string args, string workDir)
        {
            IShellLinkW link = (IShellLinkW)new ShellLinkObject();
            try
            {
                link.SetPath(target);
                link.SetArguments(args ?? "");
                link.SetWorkingDirectory(workDir);
                link.SetIconLocation(target, 0);
                link.SetDescription("Equipment checkout and returns for the front desk");
                Directory.CreateDirectory(Path.GetDirectoryName(linkPath));
                ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Save(linkPath, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(link);
            }
        }

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkObject
        {
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
            void GetIDList(out IntPtr idl);
            void SetIDList(IntPtr idl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out short hotkey);
            void SetHotkey(short hotkey);
            void GetShowCmd(out int showCmd);
            void SetShowCmd(int showCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string rel, int reserved);
            void Resolve(IntPtr hwnd, int flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }
    }

    /// <summary>The small window setup shows: a heading, a line or two, some options, two buttons.</summary>
    internal sealed class SetupForm : Form
    {
        private readonly FlowLayoutPanel _options;

        public SetupForm(string title, string heading, string body, string okText)
        {
            Text = title;
            Font = SystemFonts.MessageBoxFont;
            AutoScaleMode = AutoScaleMode.Font;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }

            FlowLayoutPanel page = new FlowLayoutPanel();
            page.FlowDirection = FlowDirection.TopDown;
            page.WrapContents = false;
            page.AutoSize = true;
            page.Padding = new Padding(24, 20, 24, 16);

            Label h = new Label();
            h.Text = heading;
            h.AutoSize = true;
            h.Font = new Font(Font.FontFamily, Font.SizeInPoints * 1.5f, FontStyle.Bold);
            h.ForeColor = ColorTranslator.FromHtml("#E6007E");
            h.Margin = new Padding(0, 0, 0, 10);
            page.Controls.Add(h);

            Label b = new Label();
            b.Text = body;
            b.AutoSize = true;
            b.MaximumSize = new Size(460, 0);
            b.Margin = new Padding(0, 0, 0, 14);
            page.Controls.Add(b);

            _options = new FlowLayoutPanel();
            _options.FlowDirection = FlowDirection.TopDown;
            _options.WrapContents = false;
            _options.AutoSize = true;
            _options.Margin = new Padding(0, 0, 0, 16);
            page.Controls.Add(_options);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.AutoSize = true;
            buttons.Anchor = AnchorStyles.Right;
            buttons.MinimumSize = new Size(460, 0);
            Button ok = new Button();
            ok.Text = okText;
            ok.DialogResult = DialogResult.OK;
            ok.AutoSize = true;
            ok.MinimumSize = new Size(96, 30);
            Button cancel = new Button();
            cancel.Text = "Cancel";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.AutoSize = true;
            cancel.MinimumSize = new Size(96, 30);
            buttons.Controls.Add(ok);
            buttons.Controls.Add(cancel);
            page.Controls.Add(buttons);

            Controls.Add(page);
            AcceptButton = ok;
            CancelButton = cancel;
        }

        public CheckBox AddOption(string text, bool on, string hint)
        {
            CheckBox c = new CheckBox();
            c.Text = text;
            c.Checked = on;
            c.AutoSize = true;
            c.Margin = new Padding(0, 4, 0, hint == null ? 4 : 0);
            _options.Controls.Add(c);
            if (hint != null)
            {
                Label l = new Label();
                l.Text = hint;
                l.AutoSize = true;
                l.MaximumSize = new Size(440, 0);
                l.ForeColor = Color.DimGray;
                l.Margin = new Padding(18, 0, 0, 6);
                _options.Controls.Add(l);
            }
            return c;
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

        /// <summary>Setup sets this to ask a running copy to close, so it can be updated or removed.</summary>
        public const string QuitEventName = @"Local\RFrontDesk.Quit";

        private EventWaitHandle _quitEvent;
        private RegisteredWaitHandle _quitWait;
        private bool _quitting;
        private bool _asking;
        private bool _gaveUp;
        private readonly List<DateTime> _recoveries = new List<DateTime>();

        private WebView2 _web;
        private NotifyIcon _tray;
        private ToolStripMenuItem _autostartItem;
        private ToolStripMenuItem _devToolsItem;
        private bool _fullScreen;
        private readonly StartupOptions _startup;

        public MainForm(StartupOptions startup)
        {
            _startup = startup;

            Text = "RFrontDesk";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 640);
            Size = new Size(1280, 860);
            BackColor = Color.FromArgb(10, 10, 11);
            // A kiosk fills the screen with no frame: no title bar, no close or
            // minimise buttons, and the taskbar covered. It used to open as a
            // normal window, one click from the desktop. The frame has to go
            // before the window is maximised, or the taskbar stays in front.
            if (_startup.Kiosk)
            {
                FormBorderStyle = FormBorderStyle.None;
                _fullScreen = true;
            }
            WindowState = FormWindowState.Maximized;
            KeyPreview = true;

            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);

            BuildTray();
            ListenForQuit();
        }

        private void ListenForQuit()
        {
            try
            {
                _quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
                _quitWait = ThreadPool.RegisterWaitForSingleObject(_quitEvent, delegate(object state, bool timedOut)
                {
                    try { BeginInvoke((Action)QuitForSetup); }
                    catch { }
                }, null, Timeout.Infinite, true);
            }
            catch (Exception ex)
            {
                Paths.Log("could not listen for setup: " + ex.Message);
            }
        }

        /// <summary>Setup is replacing or removing the app. Close, even on a kiosk.</summary>
        private void QuitForSetup()
        {
            Paths.Log("closing so setup can update or remove the app");
            _quitting = true;
            if (_tray != null) _tray.Visible = false;
            Close();
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // Start in the tray when Windows launched us, so autostart does not
            // throw a window over whatever the operator was already doing.
            // Not a kiosk, though: a public tablet that starts hidden in the tray
            // shows the desktop to whoever walks up after a reboot.
            if (_startup.Minimized && !_startup.Kiosk)
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

            if (_startup.Unknown.Count > 0)
                Paths.Log("ignored unknown flags: " + string.Join(" ", _startup.Unknown.ToArray()) + (_startup.Kiosk ? " (running locked)" : ""));
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
        // The log is a plain file beside the app and is never trimmed, so it
        // records the kind of link, not the phone number in it.
        private static string SchemeOf(string uri)
        {
            int i = uri == null ? -1 : uri.IndexOf(':');
            return i > 0 ? uri.Substring(0, i) + ":" : "(link)";
        }

        private bool TryShellScheme(string uri)
        {
            if (!IsShellScheme(uri)) return false;
            if (!_startup.DevTools)
            {
                Paths.Log("refused shell link on a locked-down install: " + SchemeOf(uri));
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
                Paths.Log("could not open a " + SchemeOf(uri) + " link: " + ex.Message);
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

        internal enum Recovery { Ignore, Reload, AskReload, Recreate }

        /// <summary>
        /// What to do when a part of the browser stops.
        ///
        /// It used to be one "Reload?" box for everything. That was wrong both
        /// ways: a GPU or helper process that WebView2 restarts on its own put a
        /// pointless question in front of the desk, and when the browser itself
        /// had gone, Reload threw -- there was nothing left to reload -- and the
        /// window stayed blank until someone restarted the app.
        /// </summary>
        internal static Recovery RecoveryFor(CoreWebView2ProcessFailedKind kind, bool kiosk)
        {
            switch (kind)
            {
                case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                    return Recovery.Recreate;
                case CoreWebView2ProcessFailedKind.RenderProcessExited:
                    return Recovery.Reload;
                case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                    // Staff can choose to wait; a public tablet has nobody to ask.
                    return kiosk ? Recovery.Reload : Recovery.AskReload;
                default:
                    // Frames, GPU, utility and helper processes: WebView2 brings
                    // these back by itself.
                    return Recovery.Ignore;
            }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            CoreWebView2ProcessFailedKind kind = e.ProcessFailedKind;
            Recovery r = RecoveryFor(kind, _startup.Kiosk);
            Paths.Log("webview process failed: " + kind + " -> " + r);
            if (r == Recovery.Ignore) return;
            OnUi(delegate { Recover(r); });
        }

        /// <summary>
        /// More than three recoveries in two minutes means something is really
        /// wrong; reloading for ever would only hide it.
        /// </summary>
        private bool TooManyRecoveries()
        {
            DateTime now = DateTime.UtcNow;
            _recoveries.RemoveAll(delegate(DateTime t) { return (now - t).TotalMinutes > 2; });
            _recoveries.Add(now);
            return _recoveries.Count > 3;
        }

        private async void Recover(Recovery r)
        {
            if (_asking || _gaveUp || _quitting) return;
            if (r == Recovery.AskReload)
            {
                _asking = true;
                DialogResult d = MessageBox.Show(this,
                    "The page is not responding.\r\n\r\nReload it now? Choose No to give it a little longer.",
                    "Front Desk", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                _asking = false;
                if (d != DialogResult.Yes) return;
                r = Recovery.Reload;
            }
            if (TooManyRecoveries())
            {
                _gaveUp = true;
                Paths.Log("the page keeps failing; stopped recovering it");
                MessageBox.Show(this,
                    "Front Desk keeps stopping. Restart the computer. If it happens again, " +
                    "send the log to whoever looks after this desk:\r\n\r\n" + Paths.LogFile,
                    "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            try
            {
                if (r == Recovery.Reload && _web.CoreWebView2 != null)
                {
                    _web.CoreWebView2.Reload();
                    return;
                }
                await RecreateWebViewAsync();
            }
            catch (Exception ex)
            {
                Paths.Log("recovery failed: " + ex);
            }
        }

        /// <summary>
        /// The browser process is gone, and with it the control's CoreWebView2.
        /// The only way back is a new control on a new environment; the data
        /// folder is the same, so the desk comes back with its records.
        /// </summary>
        private async System.Threading.Tasks.Task RecreateWebViewAsync()
        {
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    // Give the old browser time to let go of the data folder.
                    await System.Threading.Tasks.Task.Delay(1000 * attempt);
                    WebView2 old = _web;
                    _web = new WebView2();
                    _web.Dock = DockStyle.Fill;
                    Controls.Add(_web);
                    Controls.Remove(old);
                    try { old.Dispose(); }
                    catch { }
                    await InitWebViewAsync();
                    Paths.Log("browser restarted (attempt " + attempt + ")");
                    return;
                }
                catch (Exception ex)
                {
                    Paths.Log("browser restart attempt " + attempt + " failed: " + ex.Message);
                }
            }
            MessageBox.Show(this,
                "Front Desk could not restart its page. Restart the computer, or close Front Desk and open it again.",
                "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                Paths.Log("page: " + Paths.OneLine(e.TryGetWebMessageAsString(), 2000));
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
            _tray.Text = "RFrontDesk";
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
            // On a kiosk the tray offers nothing that leaves the app. "Open
            // folder" was File Explorer -- and from its address bar, a command
            // prompt -- on the public tablet, beside the backups that hold every
            // name and phone number. Exit and the startup toggle went too: set
            // those up from an ordinary (unlocked) start.
            if (_startup.Kiosk)
            {
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Reload", null, delegate
                {
                    if (_web.CoreWebView2 != null) _web.CoreWebView2.Reload();
                });
                _tray.ContextMenuStrip = menu;
                return;
            }
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
            // A kiosk stays full screen: F11 and Escape used to drop it back to a
            // window with a close button.
            if (_startup.Kiosk && (e.KeyCode == Keys.F11 || e.KeyCode == Keys.Escape))
            {
                e.Handled = true;
                return;
            }
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
            // Alt+F4 at the public tablet used to quit the desk. Windows shutting
            // down, a sign-out or Task Manager (which needs Ctrl+Alt+Del) still
            // close it; a person standing at the screen does not.
            if (_startup.Kiosk && e.CloseReason == CloseReason.UserClosing && !_quitting)
            {
                e.Cancel = true;
                return;
            }
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
                if (_quitWait != null) _quitWait.Unregister(null);
                if (_quitEvent != null) _quitEvent.Dispose();
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
            StartupOptions startup = StartupOptions.Current;

            // Setup runs instead of the app, before the single-instance check:
            // it is often run while the app is open, to update it.
            if (startup.Install || startup.Uninstall)
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Environment.ExitCode = startup.Install ? Installer.Install(startup) : Installer.Uninstall(startup);
                return;
            }

            // Double-clicking the exe inside a zip extracts that one file and
            // runs it alone. Say what to do, instead of failing to load WebView2.
            string missing = Installer.MissingFiles(AppDomain.CurrentDomain.BaseDirectory);
            if (missing != null)
            {
                Application.EnableVisualStyles();
                MessageBox.Show(
                    "Front Desk is missing some of its files (" + missing + ").\r\n\r\n" +
                    "If you opened it from inside the zip, close it, right-click the zip, choose Extract All, " +
                    "and then run \"Install Front Desk\" from the folder that makes.",
                    "Front Desk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            RunApp(startup);
        }

        // Kept out of Main so that setup, and the missing-files message, never
        // need the WebView2 assemblies to be loadable.
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        private static void RunApp(StartupOptions startup)
        {
            bool createdNew;
            _instance = new Mutex(true, @"Local\RFrontDesk.SingleInstance", out createdNew);
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
            Paths.Resolve();
            Installer.CleanLeftovers();
            Autostart.RepairIfStale();
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
