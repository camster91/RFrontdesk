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
// And it starts no window, reads no registry and touches no network. The one
// check that would prove the autostart value end to end -- write the Run key,
// read it back -- would mean changing a real logon setting, and a test suite is
// not the place to do that. So what is pinned here is the decision: given this
// command line, and this URL, what does the host do. The Run key itself is a
// `SetValue` of `Autostart.Command()`, and the command is checked here.
//
// C# 5, like the source it is compiled with: this compiler is the in-box one.

using System;
using System.Windows.Forms;

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
            else ParseAndUrls();

            Console.WriteLine("  " + _checks + " checks in mode '" + mode + "', " + _failures + " failed");
            return _failures == 0 ? 0 : 1;
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
                MainForm.IsShellScheme("mailto:desk@rotman.utoronto.ca"), null);
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
