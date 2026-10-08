// Checks for the Windows host: the parts of host\FrontDesk.cs that are pure
// logic and that nothing else in this project can reach.
//
//   node tools\test-host.cjs      -- compiles this and FrontDesk.cs, then runs it
//
// Two decisions worth knowing about.
//
// It is compiled *with* FrontDesk.cs rather than beside it, so there is no copy
// of anything to drift: the checks below call the shipping source directly.
//
// It starts no window and touches no network. Registry checks use a unique
// Software\RFrontDesk-Tests\Autostart-* key, removed in finally. They never open
// or write a Windows Run key, so running this suite creates no logon entry.
//
// C# 5, like the source it is compiled with: this compiler is the in-box one.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

namespace FrontDeskHost
{
    internal static class HostTests
    {
        private static int _failures;
        private static int _checks;

        private static void Check(string name, bool ok, string detail)
        {
            _checks++;
            if (ok)
            {
                Console.WriteLine("  ok  " + name);
                return;
            }
            _failures++;
            Console.WriteLine("FAIL  " + name + (detail == null ? "" : "  -> " + detail));
        }

        private static string Mode(string[] argv)
        {
            // No skipping: .NET's Main gets args with the program name already
            // gone. (Environment.GetCommandLineArgs is the one that keeps it, and
            // StartupOptions deals with that itself.)
            foreach (string a in argv)
            {
                if (a.StartsWith("--mode=", StringComparison.Ordinal))
                    return a.Substring("--mode=".Length);
            }
            return "parse";
        }

        private static int Main(string[] argv)
        {
            string mode = Mode(argv);
            if (mode == "kiosk") Kiosk();
            else if (mode == "plain") Plain();
            else if (mode == "files") Files();
            else if (mode == "registry") RegistryRoundTrip();
            else
            {
                ParseAndUrls();
                Decisions();
            }

            Console.WriteLine("  " + _checks + " checks in mode '" + mode + "', " + _failures + " failed");
            return _failures == 0 ? 0 : 1;
        }

        private static void RegistryRoundTrip()
        {
            string path = @"Software\RFrontDesk-Tests\Autostart-" + Guid.NewGuid().ToString("N");
            string exe = @"C:\Program Files\RFrontDesk\RFrontDesk.exe";
            string kiosk = Autostart.CommandFor(exe, false);
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(path))
                {
                    key.SetValue("Unrelated", "keep");
                    Autostart.WriteEntry(key, true, kiosk);
                }
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, true))
                {
                    Check("startup command survives closing and reopening its key",
                        (string)key.GetValue("RFrontDesk") == "\"" + exe + "\" --minimized --no-devtools", null);
                    Check("startup command is stored as a string",
                        key.GetValueKind("RFrontDesk") == RegistryValueKind.String, null);
                    Autostart.WriteEntry(key, true, Autostart.CommandFor(exe, true));
                }
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, true))
                {
                    Check("updating startup replaces the command",
                        (string)key.GetValue("RFrontDesk") == "\"" + exe + "\" --minimized", null);
                    Autostart.WriteEntry(key, false, null);
                    Autostart.WriteEntry(key, false, null);
                }
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, false))
                {
                    Check("disabling startup removes the value, including repeated disable",
                        key.GetValue("RFrontDesk") == null, null);
                    Check("disabling startup preserves unrelated values",
                        (string)key.GetValue("Unrelated") == "keep", null);
                }
            }
            finally
            {
                Registry.CurrentUser.DeleteSubKeyTree(path, false);
            }
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path, false))
                Check("registry test removes its disposable key", key == null, null);
        }

        /// <summary>
        /// The command line, and which URLs the window will load. Neither depends
        /// on how this test process happened to be started.
        /// </summary>
        private static void ParseAndUrls()
        {
            StartupOptions none = StartupOptions.Parse(new string[] { "app.exe" });
            Check("no flags leaves devtools on", none.DevTools, null);
            Check("no flags does not claim a minimized start", !none.Minimized, null);

            StartupOptions min = StartupOptions.Parse(new string[] { "app.exe", "--minimized" });
            Check("--minimized is recognised", min.Minimized, null);

            StartupOptions kiosk = StartupOptions.Parse(new string[] { "app.exe", "--no-devtools" });
            Check("--no-devtools turns devtools off", !kiosk.DevTools, null);

            StartupOptions ci = StartupOptions.Parse(new string[] { "app.exe", "--NO-DEVTOOLS" });
            Check("flags are matched without regard to case", !ci.DevTools, null);

            StartupOptions last = StartupOptions.Parse(new string[] { "app.exe", "--no-devtools", "--devtools" });
            Check("a later --devtools wins over an earlier --no-devtools", last.DevTools, null);

            StartupOptions nothing = StartupOptions.Parse(null);
            Check("a null command line is not a crash", nothing != null && nothing.DevTools, null);

            // Parse's contract, which Current depends on: every element is a flag.
            // (Getting this wrong is how the exe's own path becomes a setting, or
            // the first real flag disappears.)
            StartupOptions bare = StartupOptions.Parse(new string[] { "--no-devtools" });
            Check("every argument Parse is given is read as a flag", !bare.DevTools, null);

            // A misspelt lock flag locks. It used to be ignored, leaving a public
            // kiosk unlocked with nothing to say so.
            foreach (string typo in new string[] { "--no-devtool", "--nodevtools", "--no_devtools", "-no-dev-tools" })
            {
                StartupOptions t = StartupOptions.Parse(new string[] { "app.exe", typo });
                Check("a misspelt lock flag (" + typo + ") still locks", t.Kiosk && t.Unknown.Count == 1, null);
            }
            StartupOptions other = StartupOptions.Parse(new string[] { "app.exe", "--something-new" });
            Check("an unrelated unknown flag is ignored, not a lock", !other.Kiosk && other.Unknown.Count == 1, null);
            Check("Kiosk is the same thing as --no-devtools", kiosk.Kiosk && !none.Kiosk, null);

            // The virtual host is the only origin allowed to load in the window.
            Check("the app's own page is allowed", MainForm.IsAppUri("https://frontdesk.local/index.html"), null);
            Check("the bare host is allowed", MainForm.IsAppUri("https://frontdesk.local/"), null);
            Check("the host is matched without regard to case", MainForm.IsAppUri("https://FRONTDESK.LOCAL/"), null);
            Check("about:blank is allowed", MainForm.IsAppUri("about:blank"), null);

            Check("plain http to the same name is a different origin, and is refused",
                !MainForm.IsAppUri("http://frontdesk.local/index.html"), null);
            Check("a lookalike host is refused",
                !MainForm.IsAppUri("https://frontdesk.local.example.com/"), null);
            Check("userinfo does not smuggle another host past the check",
                !MainForm.IsAppUri("https://frontdesk.local@example.com/"), null);
            Check("an outside site is refused", !MainForm.IsAppUri("https://example.com/"), null);
            Check("a local file is refused",
                !MainForm.IsAppUri("file:///C:/Windows/System32/drivers/etc/hosts"), null);
            Check("a javascript: url is refused", !MainForm.IsAppUri("javascript:alert(1)"), null);
            Check("a data: url is refused", !MainForm.IsAppUri("data:text/html,<b>x</b>"), null);
            Check("an empty url is refused", !MainForm.IsAppUri(""), null);
            Check("a null url is refused", !MainForm.IsAppUri(null), null);

            // A phone number or an address is not a page: those go to Windows.
            Check("a phone number is a shell link", MainForm.IsShellScheme("tel:+14165551234"), null);
            Check("a text message is a shell link", MainForm.IsShellScheme("sms:+14165551234"), null);
            Check("an email address is a shell link",
                MainForm.IsShellScheme("mailto:desk@example.org"), null);
            Check("shell schemes are matched without regard to case",
                MainForm.IsShellScheme("TEL:+14165551234"), null);
            Check("a page is not a shell link",
                !MainForm.IsShellScheme("https://frontdesk.local/index.html"), null);
            Check("a javascript: url is not a shell link",
                !MainForm.IsShellScheme("javascript:alert(1)"), null);
            Check("an empty string is not a shell link", !MainForm.IsShellScheme(""), null);
            Check("a null string is not a shell link", !MainForm.IsShellScheme(null), null);
            Check("an absurdly long link never reaches the shell",
                !MainForm.IsShellScheme("tel:" + new string('9', 600)), null);
        }

        /// <summary>
        /// The Windows-side choices that used to go wrong: the startup entry, the
        /// data folder, backup cleanup, the log, and what a browser crash does.
        /// </summary>
        private static void Decisions()
        {
            // Setup flags.
            StartupOptions inst = StartupOptions.Parse(new string[] { "--install", "--quiet", "--kiosk", "--autostart", "--no-desktop" });
            Check("--install and its options are recognised",
                inst.Install && inst.Quiet && inst.AutostartOnInstall && inst.NoDesktopShortcut && inst.Unknown.Count == 0, null);
            Check("--kiosk locks, the same as --no-devtools", inst.Kiosk, null);
            StartupOptions un = StartupOptions.Parse(new string[] { "--uninstall", "--delete-data" });
            Check("--uninstall and --delete-data are recognised", un.Uninstall && un.DeleteData && !un.Kiosk, null);
            StartupOptions self = StartupOptions.Parse(new string[] { "--selftest" });
            Check("--selftest is recognised", self.SelfTest, null);
            Check("--no-desktop is not mistaken for a misspelt lock flag", !inst.Unknown.Contains("--no-desktop"), null);

            // The startup entry.
            string exe = @"C:\Users\desk\AppData\Local\Programs\RFrontDesk\RFrontDesk.exe";
            string other = @"E:\Front Desk\RFrontDesk.exe";
            Func<string, bool> allExist = delegate(string f) { return true; };
            Func<string, bool> noneExist = delegate(string f) { return false; };
            Check("the exe is read out of a quoted entry",
                Autostart.ExeOf("\"" + exe + "\" --minimized") == exe, null);
            Check("the exe is read out of an unquoted entry",
                Autostart.ExeOf(@"C:\fd\RFrontDesk.exe --minimized") == @"C:\fd\RFrontDesk.exe", null);
            Check("no entry is left alone", Autostart.Repair(null, exe, true, allExist) == null, null);
            Check("an up-to-date entry is left alone",
                Autostart.Repair(Autostart.CommandFor(exe, true), exe, true, allExist) == null, null);
            Check("this copy's entry with old flags is brought up to date",
                Autostart.Repair("\"" + exe + "\"", exe, true, allExist) == Autostart.CommandFor(exe, true), null);
            Check("an entry for a moved or deleted copy is pointed at this one",
                Autostart.Repair("\"" + other + "\" --minimized", exe, true, noneExist) == Autostart.CommandFor(exe, true), null);
            Check("another copy's working entry is not taken over",
                Autostart.Repair("\"" + other + "\" --minimized", exe, true, allExist) == null, null);
            string fixedLocked = Autostart.Repair("\"" + other + "\" --minimized --no-devtools", exe, true, noneExist);
            Check("a correction never drops the kiosk lock",
                fixedLocked != null && Autostart.IsLocked(fixedLocked), fixedLocked);
            string fixedByKiosk = Autostart.Repair(Autostart.CommandFor(exe, true), exe, false, allExist);
            Check("a locked launch locks its own entry",
                fixedByKiosk != null && Autostart.IsLocked(fixedByKiosk), fixedByKiosk);

            // The install offer, which replaced the zip's install script.
            string unzipped = @"C:\Users\desk\Downloads\RFrontDesk";
            string installed = @"C:\Users\desk\AppData\Local\Programs\RFrontDesk";
            Func<string, bool> nothing = delegate(string f) { return false; };
            Check("a fresh unzipped copy offers to install",
                Installer.ShouldOffer(unzipped, installed, nothing, false), null);
            Check("the installed copy never offers",
                !Installer.ShouldOffer(installed + Path.DirectorySeparatorChar, installed, nothing, false), null);
            Check("a start-with-Windows launch never offers",
                !Installer.ShouldOffer(unzipped, installed, nothing, true), null);
            Check("a copy that already holds records never offers",
                !Installer.ShouldOffer(unzipped, installed,
                    delegate(string f) { return f.EndsWith(Path.Combine("data", "browser"), StringComparison.Ordinal); }, false), null);
            Check("\"Run from this folder\" is remembered",
                !Installer.ShouldOffer(unzipped, installed,
                    delegate(string f) { return f.EndsWith(Installer.RunHereMarker, StringComparison.Ordinal); }, false), null);

            // A package has a different identity and a different writable
            // root. The family is stable across package updates, while a
            // malformed identity must not produce a plausible path.
            Check("package family is derived from identity name and publisher id",
                PackageIdentity.FamilyName("CameronAshley.RFrontDesk_1.1.0.0_x64__abc123") ==
                    "CameronAshley.RFrontDesk_abc123", null);
            Check("malformed package identity has no family",
                PackageIdentity.FamilyName("not-a-package") == null, null);
            Check("package data is under LocalCache\\Local", PackageIdentity.DataDirectory(
                @"C:\Users\desk\AppData\Local", "FrontDesk_abc") ==
                @"C:\Users\desk\AppData\Local\Packages\FrontDesk_abc\LocalCache\Local\FrontDesk", null);

            string migration = Path.Combine(Path.GetTempPath(), "frontdesk-migration-" + Guid.NewGuid().ToString("N"));
            string legacy = Path.Combine(migration, "legacy");
            string packaged = Path.Combine(migration, "packaged");
            try
            {
                Directory.CreateDirectory(Path.Combine(legacy, "browser", "IndexedDB"));
                Directory.CreateDirectory(Path.Combine(legacy, "backups"));
                Directory.CreateDirectory(Path.Combine(packaged, "browser", "IndexedDB"));
                File.WriteAllText(Path.Combine(legacy, "browser", "IndexedDB", "records"), "legacy records");
                File.WriteAllText(Path.Combine(legacy, "backups", "backup.json"), "legacy backup");
                File.WriteAllText(Path.Combine(packaged, "browser", "IndexedDB", "records"), "new package records");
                int copied = Paths.MigrateLegacyData(legacy, packaged);
                Check("legacy migration copies missing nested data", copied == 1 &&
                    File.Exists(Path.Combine(packaged, "backups", "backup.json")), null);
                Check("legacy migration never overwrites package IndexedDB",
                    File.ReadAllText(Path.Combine(packaged, "browser", "IndexedDB", "records")) == "new package records", null);
                Check("legacy migration records a retry-safe marker",
                    File.Exists(Path.Combine(packaged, ".legacy-data-migrated-v1")), null);
                File.WriteAllText(Path.Combine(legacy, "backups", "new.json"), "new backup");
                Check("completed migration does not unexpectedly recopy files",
                    Paths.MigrateLegacyData(legacy, packaged) == 0 &&
                    !File.Exists(Path.Combine(packaged, "backups", "new.json")), null);
            }
            finally
            {
                try { if (Directory.Exists(migration)) Directory.Delete(migration, true); }
                catch { }
            }

            // The data folder.
            bool portable;
            string root = @"C:\fd";
            string fallback = @"C:\Users\desk\AppData\Local\FrontDesk\data";
            Func<string, bool> writable = delegate(string d) { return true; };
            Func<string, bool> notWritable = delegate(string d) { return false; };
            Func<string, bool> hasDb = delegate(string d) { return d.EndsWith("browser", StringComparison.Ordinal); };
            Check("a writable app folder is used",
                Paths.ChooseData(root, fallback, writable, noneExist, out portable) == Path.Combine(root, "data") && portable, null);
            Check("one failed write check does not leave the desk's database for an empty one",
                Paths.ChooseData(root, fallback, notWritable, hasDb, out portable) == Path.Combine(root, "data") && portable, null);
            Check("a read-only folder with no database still falls back",
                Paths.ChooseData(root, fallback, notWritable, noneExist, out portable) == fallback && !portable, null);

            // Backup cleanup.
            Check("a daily backup is the app's own", Bridge.IsAutoBackupName("frontdesk-backup-2026-10-06.json"), null);
            Check("a timed backup is the app's own", Bridge.IsAutoBackupName("frontdesk-backup-2026-10-06-142233.json"), null);
            Check("a copy saved by hand is not", !Bridge.IsAutoBackupName("before-the-move.json"), null);
            Check("a renamed copy is not", !Bridge.IsAutoBackupName("frontdesk-backup-2026-10-06 (keep).json"), null);
            Check("an export from elsewhere is not", !Bridge.IsAutoBackupName("frontdesk-export.json"), null);

            // The log.
            Check("a page message cannot add a log line",
                Paths.OneLine("bad\r\n2026-01-01 00:00:00  forged", 2000).IndexOf('\n') < 0, null);
            Check("a page message is capped", Paths.OneLine(new string('x', 5000), 2000).Length <= 2003, null);

            // A browser crash.
            Check("a crashed browser is rebuilt, not reloaded",
                MainForm.RecoveryFor(CoreWebView2ProcessFailedKind.BrowserProcessExited, false) == MainForm.Recovery.Recreate, null);
            Check("a crashed page reloads without asking",
                MainForm.RecoveryFor(CoreWebView2ProcessFailedKind.RenderProcessExited, false) == MainForm.Recovery.Reload, null);
            Check("a hung page asks staff first",
                MainForm.RecoveryFor(CoreWebView2ProcessFailedKind.RenderProcessUnresponsive, false) == MainForm.Recovery.AskReload, null);
            Check("a hung page on a kiosk reloads, with nobody to ask",
                MainForm.RecoveryFor(CoreWebView2ProcessFailedKind.RenderProcessUnresponsive, true) == MainForm.Recovery.Reload, null);
            Check("a GPU restart puts no question in front of the desk",
                MainForm.RecoveryFor(CoreWebView2ProcessFailedKind.GpuProcessExited, false) == MainForm.Recovery.Ignore, null);

            // Setup paths.
            Check("a folder is inside itself", Installer.IsInside(root, root), null);
            Check("a subfolder is inside", Installer.IsInside(Path.Combine(root, "data"), root), null);
            Check("a sibling with the same prefix is not inside", !Installer.IsInside(root + "-old", root), null);
            Check("the install folder is per-user",
                Installer.DefaultInstallDir().EndsWith(Path.Combine("Programs", "RFrontDesk"), StringComparison.Ordinal),
                Installer.DefaultInstallDir());
        }

        /// <summary>
        /// The parts that touch files, in a temporary folder of their own:
        /// install over an old copy, the log trim, and reading the log's tail.
        /// </summary>
        private static void Files()
        {
            string tmp = Path.Combine(Path.GetTempPath(), "fd-hosttest-" + Guid.NewGuid().ToString("N"));
            try
            {
                // A new build, with a clean data folder.
                string src = Path.Combine(tmp, "unzipped");
                Write(Path.Combine(src, "RFrontDesk.exe"), "new exe");
                Write(Path.Combine(src, "web", "index.html"), "new page");
                Write(Path.Combine(src, "data", "README.txt"), "readme");
                // An old install with records and a file the new build dropped.
                string dst = Path.Combine(tmp, "installed");
                Write(Path.Combine(dst, "RFrontDesk.exe"), "old exe");
                Write(Path.Combine(dst, "web", "old.js"), "old");
                Write(Path.Combine(dst, "data", "browser", "db"), "records");
                Write(Path.Combine(dst, "data", "backups", "frontdesk-backup-2026-10-01.json"), "{}");

                Installer.CopyApp(src, dst);
                Check("an update replaces the app", Read(Path.Combine(dst, "RFrontDesk.exe")) == "new exe", null);
                Check("an update removes what the new build dropped", !File.Exists(Path.Combine(dst, "web", "old.js")), null);
                Check("an update keeps the records", Read(Path.Combine(dst, "data", "browser", "db")) == "records", null);
                Check("an update keeps the backups",
                    File.Exists(Path.Combine(dst, "data", "backups", "frontdesk-backup-2026-10-01.json")), null);
                Check("an update leaves no staging folder", !Directory.Exists(Path.Combine(dst, ".setup-new")), null);

                // A first install from a folder the desk was already being run from.
                string used = Path.Combine(tmp, "used");
                Write(Path.Combine(used, "RFrontDesk.exe"), "exe");
                Write(Path.Combine(used, "data", "browser", "db"), "portable records");
                string fresh = Path.Combine(tmp, "fresh");
                Installer.CopyApp(used, fresh);
                Check("a first install brings the records along",
                    Read(Path.Combine(fresh, "data", "browser", "db")) == "portable records", null);
                Check("and makes a backups folder", Directory.Exists(Path.Combine(fresh, "data", "backups")), null);
                Check("and leaves the source alone", File.Exists(Path.Combine(used, "data", "browser", "db")), null);

                // The log.
                string log = Path.Combine(tmp, "frontdesk.log");
                StringBuilder big = new StringBuilder();
                for (int i = 0; i < 3000; i++) big.Append("line " + i + "\n");
                File.WriteAllText(log, big.ToString());
                string tail = Paths.Tail(log, 100);
                Check("the tail ends with the last line", tail.EndsWith("line 2999\n", StringComparison.Ordinal), tail);
                Check("the tail starts on a whole line", tail.StartsWith("line ", StringComparison.Ordinal), tail);
                Check("the tail is short", tail.Length <= 100, null);
                Check("a short log is read whole", Paths.Tail(Path.Combine(tmp, "unzipped", "data", "README.txt"), 100) == "readme", null);
                Check("a missing log reads as empty", Paths.Tail(Path.Combine(tmp, "nope.log"), 100) == "", null);

                Paths.RollLog(log, 1000);
                Check("a long log is set aside", !File.Exists(log) && File.Exists(log + ".1"), null);
                File.WriteAllText(log, "small");
                Paths.RollLog(log, 1000);
                Check("a short log is left alone", File.Exists(log), null);
            }
            finally
            {
                try { Directory.Delete(tmp, true); }
                catch { }
            }
        }

        private static void Write(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, text);
        }

        private static string Read(string path)
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }

        /// <summary>
        /// The regression this area is about, measured on a process that really
        /// was started with --no-devtools.
        /// </summary>
        private static void Kiosk()
        {
            Check("this run was started with --no-devtools", !StartupOptions.Current.DevTools,
                "the command line did not carry the flag, so this check proves nothing");

            string cmd = Autostart.Command();
            Check("the startup entry keeps --no-devtools",
                cmd.IndexOf("--no-devtools", StringComparison.Ordinal) > 0, cmd);
            Check("the startup entry keeps starting minimised",
                cmd.IndexOf("--minimized", StringComparison.Ordinal) > 0, cmd);
            Check("the startup entry is the quoted exe first",
                cmd.StartsWith("\"", StringComparison.Ordinal) &&
                cmd.IndexOf("\"", 1, StringComparison.Ordinal) > 1, cmd);
            Check("it is not the old fixed string that dropped the flag",
                cmd != "\"" + Application.ExecutablePath + "\" --minimized", cmd);
        }

        /// <summary>
        /// An ordinary install. The old value's --minimized has to survive here
        /// too: writing flags back from the command line alone would have dropped
        /// it, and the app would come up as a window over the desk at logon.
        /// </summary>
        private static void Plain()
        {
            Check("this run was started with devtools available", StartupOptions.Current.DevTools, null);

            string cmd = Autostart.Command();
            Check("an ordinary install writes no --no-devtools",
                cmd.IndexOf("--no-devtools", StringComparison.Ordinal) < 0, cmd);
            Check("an ordinary install still starts minimised",
                cmd.IndexOf("--minimized", StringComparison.Ordinal) > 0, cmd);
        }
    }
}
