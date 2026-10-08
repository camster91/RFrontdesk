// What the built exe says about itself.
//
// This file exists for the security software, not for the user. Compiled with
// the in-box csc, an exe carries a Win32 version resource built from these
// attributes; without them the resource is blank, and a small, unsigned,
// freshly-written binary with no product name, no description and file version
// 0.0.0.0 is the profile an endpoint agent is most suspicious of. Filling them
// in does not make the exe trusted -- only a signature does that -- but it does
// make it describe itself as the in-house tool it is.
//
// AssemblyTitle is what Explorer, Task Manager and the agent's own UI show as
// the file description, so it is the one that matters most.

using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("RFrontDesk")]
[assembly: AssemblyDescription("Equipment checkout and returns for the front desk.")]
[assembly: AssemblyProduct("RFrontDesk")]
// Company matches the name on the code-signing certificate, so the file's own
// description and its signature agree. A mismatch is one more thing an
// endpoint agent can score.
[assembly: AssemblyCompany("Cameron Ashley")]
[assembly: AssemblyCopyright("Copyright (c) Cameron Ashley")]
[assembly: AssemblyConfiguration("Release")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: ComVisible(false)]
